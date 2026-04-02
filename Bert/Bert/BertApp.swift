import SwiftUI

@main
struct BertApp: App {
    @StateObject private var serverManager = ServerManager()

    var body: some Scene {
        WindowGroup {
            Group {
                switch serverManager.state {
                case .running:
                    ContentView()
                case .initializing:
                    ServerInitializingView(progress: serverManager.syncProgress)
                case .starting, .stopped:
                    ServerStartingView()
                case .needsFullDiskAccess:
                    FullDiskAccessView {
                        serverManager.openFullDiskAccessSettings()
                    } onRetry: {
                        serverManager.start()
                    }
                case .failed(let message):
                    ServerErrorView(message: message) {
                        serverManager.start()
                    }
                }
            }
            .onAppear {
                serverManager.start()
            }
            .onReceive(NotificationCenter.default.publisher(for: NSApplication.willTerminateNotification)) { _ in
                serverManager.stop()
            }
        }
        .defaultAppWindowSize()
    }
}

struct ServerStartingView: View {
    var body: some View {
        VStack(spacing: 16) {
            ProgressView()
                .controlSize(.large)
            Text("Starting server...")
                .font(.title3)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

struct ServerInitializingView: View {
    let progress: ServerManager.SyncProgress

    @State private var anthropicKeyInput: String = ""
    @State private var openaiKeyInput: String = ""
    @State private var keySaved: Bool = false
    @State private var keySaving: Bool = false
    @State private var keyError: String? = nil

    private var stageLabel: String {
        switch progress.stage {
        case "setup": return "Preparing"
        case "etl": return "Importing Messages"
        case "embedding": return "Building Search Index"
        case "metadata": return "Generating Summaries"
        case "done": return "Finishing Up"
        default: return "Setting Up"
        }
    }

    /// Whether the sync is still in an early stage where the key can be added in time for metadata
    private var showKeyInput: Bool {
        !keySaved && (progress.stage == "" || progress.stage == "setup" || progress.stage == "etl" || progress.stage == "embedding")
    }

    var body: some View {
        VStack(spacing: 20) {
            Spacer()

            Image("Broom")
                .resizable()
                .aspectRatio(contentMode: .fit)
                .frame(width: 100, height: 100)

            Text("Getting Started")
                .font(.title)
                .fontWeight(.semibold)

            VStack(spacing: 8) {
                ProgressView(value: progress.percent, total: 100)
                    .progressViewStyle(.linear)
                    .frame(width: 340)

                HStack {
                    Text(stageLabel)
                        .font(.subheadline)
                        .fontWeight(.medium)
                        .foregroundStyle(.secondary)
                    Spacer()
                    Text("\(Int(progress.percent))%")
                        .font(.subheadline)
                        .fontWeight(.medium)
                        .foregroundStyle(.secondary)
                        .monospacedDigit()
                }
                .frame(width: 340)

                if !progress.detail.isEmpty {
                    Text(progress.detail)
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
            }

            ProgressView()
                .padding(.top, 4)

            // API key input — shown while import is still running
            if showKeyInput {
                VStack(alignment: .leading, spacing: 12) {
                    Text("Add an API key while you wait (optional)")
                        .font(.subheadline)
                        .fontWeight(.medium)

                    Text("Enables conversation summaries and action items. You can also add this later in Settings.")
                        .font(.caption)
                        .foregroundStyle(.secondary)

                    VStack(alignment: .leading, spacing: 4) {
                        Text("Anthropic API Key")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        SecureField("sk-ant-...", text: $anthropicKeyInput)
                            .textFieldStyle(.roundedBorder)
                    }

                    VStack(alignment: .leading, spacing: 4) {
                        Text("OpenAI API Key")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        SecureField("sk-...", text: $openaiKeyInput)
                            .textFieldStyle(.roundedBorder)
                    }

                    if let error = keyError {
                        Text(error)
                            .font(.caption)
                            .foregroundStyle(.red)
                    }

                    Button {
                        Task { await saveKey() }
                    } label: {
                        if keySaving {
                            HStack(spacing: 6) {
                                ProgressView()
                                    .controlSize(.mini)
                                Text("Saving...")
                            }
                        } else {
                            Text("Save Key")
                        }
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.small)
                    .disabled(keySaving || (anthropicKeyInput.isEmpty && openaiKeyInput.isEmpty))
                }
                .frame(width: 340)
                .padding(.top, 4)
            } else if keySaved {
                HStack(spacing: 4) {
                    Image(systemName: "checkmark.circle.fill")
                        .font(.caption)
                        .foregroundStyle(.green)
                    Text("API key saved — summaries will be generated automatically.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }

            Spacer()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .animation(.easeInOut(duration: 0.3), value: progress.percent)
    }

    private func readAuthToken() -> String? {
        let appSupport = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        let tokenPath = appSupport.appendingPathComponent("Bert/auth-token").path
        return try? String(contentsOfFile: tokenPath, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func saveKey() async {
        keySaving = true
        keyError = nil

        // Save to Keychain
        if !anthropicKeyInput.isEmpty {
            KeychainManager.anthropicApiKey = anthropicKeyInput
        }
        if !openaiKeyInput.isEmpty {
            KeychainManager.openaiApiKey = openaiKeyInput
        }

        // Push to server in-memory
        var updates: [String: String] = [:]
        if !anthropicKeyInput.isEmpty { updates["anthropicApiKey"] = anthropicKeyInput }
        if !openaiKeyInput.isEmpty { updates["openaiApiKey"] = openaiKeyInput }

        do {
            let url = URL(string: "http://localhost:11488/api/settings")!
            var request = URLRequest(url: url)
            request.httpMethod = "PUT"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            if let token = readAuthToken() {
                request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            }
            request.httpBody = try JSONSerialization.data(withJSONObject: updates)
            let (_, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
                keyError = "Server returned an error — try again in a moment."
                return
            }
            keySaved = true
        } catch {
            keyError = "Couldn't reach server yet — try again in a moment."
        }
        keySaving = false
    }
}

struct FullDiskAccessView: View {
    let onOpenSettings: () -> Void
    let onRetry: () -> Void

    var body: some View {
        VStack(spacing: 20) {
            Image(systemName: "lock.shield")
                .font(.system(size: 48))
                .foregroundStyle(.orange)

            Text("Full Disk Access Required")
                .font(.title2)
                .fontWeight(.semibold)

            Text("Bert needs Full Disk Access to read your iMessage history. Messages are stored locally and only sent to an LLM if you enable conversation summaries or action items.")
                .font(.body)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 40)

            VStack(alignment: .leading, spacing: 8) {
                instructionRow(step: "1", text: "Click \"Open System Settings\" below")
                instructionRow(step: "2", text: "Find Bert in the list and toggle it on")
                instructionRow(step: "3", text: "Come back here and click \"I've Enabled It\"")
            }
            .padding(.horizontal, 40)

            HStack(spacing: 12) {
                Button("Open System Settings") {
                    onOpenSettings()
                }
                .buttonStyle(.borderedProminent)

                Button("I've Enabled It") {
                    onRetry()
                }
                .buttonStyle(.bordered)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func instructionRow(step: String, text: String) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Text(step)
                .font(.caption)
                .fontWeight(.bold)
                .foregroundStyle(.white)
                .frame(width: 20, height: 20)
                .background(Color.accentColor)
                .clipShape(Circle())
            Text(text)
                .font(.callout)
                .foregroundStyle(.secondary)
        }
    }
}

struct ServerErrorView: View {
    let message: String
    let retry: () -> Void

    var body: some View {
        VStack(spacing: 16) {
            Image(systemName: "exclamationmark.triangle")
                .font(.system(size: 40))
                .foregroundStyle(.orange)
            Text("Server Error")
                .font(.title2)
                .fontWeight(.semibold)

            ScrollView {
                Text(message)
                    .font(.system(.caption, design: .monospaced))
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(12)
            }
            .frame(maxHeight: 200)
            .background(Color(nsColor: .controlBackgroundColor))
            .cornerRadius(8)
            .padding(.horizontal, 40)

            HStack(spacing: 12) {
                Button("Copy Error") {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(message, forType: .string)
                }
                .buttonStyle(.bordered)

                Button("Retry") {
                    retry()
                }
                .buttonStyle(.borderedProminent)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

extension Scene {
    func defaultAppWindowSize() -> some Scene {
        if #available(macOS 14.0, *) {
            return self.defaultSize(width: 800, height: 600)
        } else {
            return self
        }
    }
}
