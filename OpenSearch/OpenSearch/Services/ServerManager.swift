import AppKit
import Foundation
import os

@MainActor
final class ServerManager: ObservableObject {
    enum State: Equatable {
        case stopped
        case starting
        case initializing  // server is up but running first-time sync
        case running
        case failed(String)
        case needsFullDiskAccess
    }

    struct SyncProgress: Equatable {
        var stage: String = ""
        var detail: String = ""
        var percent: Double = 0
    }

    @Published private(set) var state: State = .stopped
    @Published private(set) var lastServerLog: String = ""
    @Published private(set) var syncProgress: SyncProgress = SyncProgress()

    private var serverProcess: Process?
    private var healthTask: Task<Void, Never>?
    private nonisolated static let logger = Logger(subsystem: "com.opensearch.app", category: "ServerManager")

    /// Rolling buffer of recent stderr lines for crash diagnostics (accessed from background threads via lock)
    private nonisolated(unsafe) var recentStderr: [String] = []
    private let stderrLock = NSLock()

    private let healthURL = URL(string: "http://localhost:11488/health")!

    /// Directory containing the bundled server (node binary + dist/ + node_modules/)
    private var serverBundleURL: URL {
        Bundle.main.resourceURL!.appendingPathComponent("server")
    }

    /// Persistent data directory (~/Library/Application Support/OpenSearch/)
    private var dataDirectoryURL: URL {
        let appSupport = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        return appSupport.appendingPathComponent("OpenSearch")
    }

    /// Attempt to read the iMessage database. The attempt itself triggers macOS
    /// to add the app to the Full Disk Access list (toggled off) if not already present.
    var hasFullDiskAccess: Bool {
        let chatDBURL = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Messages/chat.db")
        // Actually try to open the file — this is what triggers macOS to register the app in FDA
        guard let _ = try? FileHandle(forReadingFrom: chatDBURL) else {
            return false
        }
        return true
    }

    func openFullDiskAccessSettings() {
        // macOS Ventura+ deep link to Full Disk Access
        if let url = URL(string: "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_AllFiles") {
            NSWorkspace.shared.open(url)
        }
    }

    func start() {
        guard state != .running && state != .starting else { return }

        if !hasFullDiskAccess {
            state = .needsFullDiskAccess
            return
        }

        state = .starting

        // Check if a server is already running on the port (e.g. from npm run serve)
        checkExistingServer()
    }

    private func checkExistingServer() {
        Task {
            do {
                let (_, response) = try await URLSession.shared.data(from: healthURL)
                if let http = response as? HTTPURLResponse, http.statusCode == 200 {
                    Self.logger.info("Existing server found on port — using it.")
                    state = .running
                    return
                }
            } catch {
                // No server running — launch our own
            }
            launchServer()
        }
    }

    /// Log file for server output — written to the data directory for easy access
    var logFileURL: URL {
        dataDirectoryURL.appendingPathComponent("server.log")
    }

    private func launchServer() {
        // Ensure data directory exists
        try? FileManager.default.createDirectory(at: dataDirectoryURL, withIntermediateDirectories: true)

        // Reset stderr buffer
        stderrLock.lock()
        recentStderr = []
        stderrLock.unlock()

        let nodeURL = serverBundleURL.appendingPathComponent("node")
        let scriptPath = serverBundleURL.appendingPathComponent("dist/server.js").path

        guard FileManager.default.fileExists(atPath: nodeURL.path) else {
            state = .failed("Server binary not found at: \(nodeURL.path)")
            return
        }
        guard FileManager.default.fileExists(atPath: scriptPath) else {
            state = .failed("Server script not found at: \(scriptPath)")
            return
        }

        // Create/truncate log file
        let logURL = logFileURL
        FileManager.default.createFile(atPath: logURL.path, contents: nil)
        let logHandle = try? FileHandle(forWritingTo: logURL)
        let header = "=== OpenSearch server started at \(ISO8601DateFormatter().string(from: Date())) ===\n"
        logHandle?.write(header.data(using: .utf8)!)

        let proc = Process()
        proc.executableURL = nodeURL
        proc.arguments = [scriptPath]
        proc.currentDirectoryURL = serverBundleURL
        proc.environment = ProcessInfo.processInfo.environment.merging([
            "DATA_DIR": dataDirectoryURL.path,
            "NODE_ENV": "production",
        ]) { _, new in new }

        // Log stdout/stderr via pipes read on background threads
        let stdoutPipe = Pipe()
        let stderrPipe = Pipe()
        proc.standardOutput = stdoutPipe
        proc.standardError = stderrPipe

        readPipeAsync(stdoutPipe, label: "stdout", logHandle: logHandle, captureStderr: false)
        readPipeAsync(stderrPipe, label: "stderr", logHandle: logHandle, captureStderr: true)

        do {
            try proc.run()
            serverProcess = proc
            Self.logger.info("Server process launched (pid: \(proc.processIdentifier))")
            Self.logger.info("Log file: \(logURL.path)")

            // Monitor for unexpected termination
            let pid = proc.processIdentifier
            Task.detached { [weak self] in
                proc.waitUntilExit()
                let code = proc.terminationStatus
                Self.logger.info("Server (pid \(pid)) exited with code \(code)")
                logHandle?.write("\n=== Server exited with code \(code) ===\n".data(using: .utf8)!)
                try? logHandle?.close()
                await self?.handleTermination(code: code)
            }

            pollHealth()
        } catch {
            state = .failed("Failed to launch server: \(error.localizedDescription)")
        }
    }

    func stop() {
        healthTask?.cancel()
        healthTask = nil

        guard let proc = serverProcess, proc.isRunning else {
            serverProcess = nil
            state = .stopped
            return
        }

        Self.logger.info("Stopping server (pid: \(proc.processIdentifier))...")
        proc.terminate()
        serverProcess = nil
        state = .stopped
    }

    private func handleTermination(code: Int32) {
        guard state == .running || state == .starting || state == .initializing else { return }
        if code != 0 {
            stderrLock.lock()
            let lastLines = recentStderr.suffix(20).joined(separator: "\n")
            stderrLock.unlock()

            let detail = lastLines.isEmpty
                ? "No error output captured."
                : lastLines
            let logPath = logFileURL.path
            lastServerLog = detail
            state = .failed("Server crashed (exit code \(code)).\n\n\(detail)\n\nFull log: \(logPath)")
        } else {
            state = .stopped
        }
    }

    private func pollHealth() {
        healthTask = Task {
            let startTime = Date()
            let startupTimeout: TimeInterval = 60
            let initTimeout: TimeInterval = 600  // First-time ingest can take a while

            // Phase 1: Wait for server to respond to health checks
            while !Task.isCancelled {
                if Date().timeIntervalSince(startTime) > startupTimeout {
                    state = .failed("Server failed to start within \(Int(startupTimeout))s")
                    serverProcess?.terminate()
                    return
                }

                if let health = await checkHealth() {
                    if health.ready {
                        state = .running
                        Self.logger.info("Server is healthy and ready.")
                        return
                    } else {
                        // Server is up but still doing initial sync
                        state = .initializing
                        Self.logger.info("Server is up, waiting for initial sync...")
                        break
                    }
                }

                try? await Task.sleep(nanoseconds: 500_000_000)
            }

            // Phase 2: Wait for initial sync to complete
            while !Task.isCancelled {
                if Date().timeIntervalSince(startTime) > initTimeout {
                    // Don't kill the server — sync might still finish, just let the user in
                    state = .running
                    Self.logger.warning("Initial sync timed out, proceeding anyway.")
                    return
                }

                if let health = await checkHealth(), health.ready {
                    state = .running
                    Self.logger.info("Initial sync complete, server ready.")
                    return
                }

                try? await Task.sleep(nanoseconds: 1_000_000_000)
            }
        }
    }

    private struct ProgressResponse: Decodable {
        let stage: String
        let detail: String
        let percent: Double
    }

    private struct HealthResponse: Decodable {
        let status: String
        let ready: Bool
        let progress: ProgressResponse?
    }

    private func checkHealth() async -> HealthResponse? {
        do {
            let (data, response) = try await URLSession.shared.data(from: healthURL)
            if let http = response as? HTTPURLResponse, http.statusCode == 200 {
                let health = try? JSONDecoder().decode(HealthResponse.self, from: data)
                if let p = health?.progress {
                    syncProgress = SyncProgress(stage: p.stage, detail: p.detail, percent: p.percent)
                }
                return health
            }
        } catch {}
        return nil
    }

    private nonisolated func readPipeAsync(_ pipe: Pipe, label: String, logHandle: FileHandle?, captureStderr: Bool) {
        let handle = pipe.fileHandleForReading
        Task.detached { [weak self] in
            for try await line in handle.bytes.lines {
                Self.logger.info("[\(label)] \(line, privacy: .public)")
                logHandle?.write("[\(label)] \(line)\n".data(using: .utf8)!)

                if captureStderr, let self {
                    self.stderrLock.lock()
                    self.recentStderr.append(line)
                    // Keep only the last 50 lines
                    if self.recentStderr.count > 50 {
                        self.recentStderr.removeFirst(self.recentStderr.count - 50)
                    }
                    self.stderrLock.unlock()
                }
            }
        }
    }
}
