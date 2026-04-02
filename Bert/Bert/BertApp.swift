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

    var body: some View {
        VStack(spacing: 20) {
            Image(systemName: "magnifyingglass.circle.fill")
                .font(.system(size: 48))
                .foregroundStyle(Color.accentColor)

            Text("Setting up Bert...")
                .font(.title3)
                .fontWeight(.medium)

            VStack(spacing: 8) {
                ProgressView(value: progress.percent, total: 100)
                    .progressViewStyle(.linear)
                    .frame(width: 300)

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
                .frame(width: 300)

                if !progress.detail.isEmpty {
                    Text(progress.detail)
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
            }

            Text("This may take a few minutes on first launch.")
                .font(.caption)
                .foregroundStyle(.tertiary)
                .padding(.top, 4)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .animation(.easeInOut(duration: 0.3), value: progress.percent)
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
