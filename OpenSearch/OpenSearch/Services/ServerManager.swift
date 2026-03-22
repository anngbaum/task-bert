import AppKit
import Foundation
import os

@MainActor
@Observable
final class ServerManager {
    enum State: Equatable {
        case stopped
        case starting
        case running
        case failed(String)
        case needsFullDiskAccess
    }

    private(set) var state: State = .stopped

    private var serverProcess: Process?
    private var healthTask: Task<Void, Never>?
    private nonisolated static let logger = Logger(subsystem: "com.opensearch.app", category: "ServerManager")

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

    private func launchServer() {
        // Ensure data directory exists
        try? FileManager.default.createDirectory(at: dataDirectoryURL, withIntermediateDirectories: true)

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

        readPipeAsync(stdoutPipe, label: "stdout")
        readPipeAsync(stderrPipe, label: "stderr")

        do {
            try proc.run()
            serverProcess = proc
            Self.logger.info("Server process launched (pid: \(proc.processIdentifier))")

            // Monitor for unexpected termination
            let pid = proc.processIdentifier
            Task.detached { [weak self] in
                proc.waitUntilExit()
                let code = proc.terminationStatus
                Self.logger.info("Server (pid \(pid)) exited with code \(code)")
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
        guard state == .running || state == .starting else { return }
        if code != 0 {
            state = .failed("Server crashed (exit code \(code))")
        } else {
            state = .stopped
        }
    }

    private func pollHealth() {
        healthTask = Task {
            let startTime = Date()
            let timeout: TimeInterval = 60  // First run may copy chat.db + ingest

            while !Task.isCancelled {
                if Date().timeIntervalSince(startTime) > timeout {
                    state = .failed("Server failed to start within \(Int(timeout))s")
                    serverProcess?.terminate()
                    return
                }

                do {
                    let (_, response) = try await URLSession.shared.data(from: healthURL)
                    if let http = response as? HTTPURLResponse, http.statusCode == 200 {
                        state = .running
                        Self.logger.info("Server is healthy.")
                        return
                    }
                } catch {
                    // Connection refused — server not ready yet
                }

                try? await Task.sleep(for: .milliseconds(500))
            }
        }
    }

    private nonisolated func readPipeAsync(_ pipe: Pipe, label: String) {
        let handle = pipe.fileHandleForReading
        Task.detached {
            for try await line in handle.bytes.lines {
                Self.logger.info("[\(label)] \(line, privacy: .public)")
            }
        }
    }
}
