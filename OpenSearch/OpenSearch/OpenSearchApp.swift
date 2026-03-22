import SwiftUI

@main
struct OpenSearchApp: App {
    @State private var serverManager = ServerManager()

    var body: some Scene {
        WindowGroup {
            Group {
                switch serverManager.state {
                case .running:
                    ContentView()
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
        .defaultSize(width: 800, height: 600)
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

            Text("OpenSearch needs Full Disk Access to read your iMessage history. Messages are stored locally and only sent to an LLM if you enable conversation summaries or action items.")
                .font(.body)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 40)

            VStack(alignment: .leading, spacing: 8) {
                instructionRow(step: "1", text: "Click \"Open System Settings\" below")
                instructionRow(step: "2", text: "Find OpenSearch in the list and toggle it on")
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
            Text(message)
                .font(.body)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 40)
            Button("Retry") {
                retry()
            }
            .buttonStyle(.borderedProminent)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
