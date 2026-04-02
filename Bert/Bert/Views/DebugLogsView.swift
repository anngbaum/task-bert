import SwiftUI

struct DebugLogsView: View {
    @ObservedObject var viewModel: SearchViewModel
    @Environment(\.dismiss) private var dismiss
    @State private var autoRefresh: Bool = false
    @State private var refreshTask: Task<Void, Never>? = nil
    @State private var filterLevel: String = "all"

    private var filteredLogs: [APIClient.LogEntry] {
        if filterLevel == "all" {
            return viewModel.debugLogs
        }
        return viewModel.debugLogs.filter { $0.level == filterLevel }
    }

    var body: some View {
        VStack(spacing: 0) {
            // Header
            HStack {
                Text("Server Logs")
                    .font(.headline)

                Spacer()

                Picker("Level", selection: $filterLevel) {
                    Text("All").tag("all")
                    Text("Errors").tag("error")
                    Text("Warnings").tag("warn")
                    Text("Info").tag("info")
                }
                .pickerStyle(.segmented)
                .frame(width: 260)

                Toggle("Auto-refresh", isOn: $autoRefresh)
                    .toggleStyle(.switch)
                    .controlSize(.small)

                Button {
                    Task { await viewModel.loadDebugLogs() }
                } label: {
                    if viewModel.isLoadingLogs {
                        ProgressView()
                            .controlSize(.small)
                    } else {
                        Image(systemName: "arrow.clockwise")
                    }
                }
                .buttonStyle(.plain)

                Button("Done") { dismiss() }
                    .keyboardShortcut(.cancelAction)
            }
            .padding()

            Divider()

            // Log list
            if filteredLogs.isEmpty {
                VStack(spacing: 8) {
                    Image(systemName: "doc.text")
                        .font(.system(size: 32))
                        .foregroundStyle(.tertiary)
                    Text(viewModel.isLoadingLogs ? "Loading..." : "No logs")
                        .foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 1) {
                            ForEach(Array(filteredLogs.enumerated()), id: \.offset) { index, log in
                                logRow(log)
                                    .id(index)
                            }
                        }
                        .padding(.horizontal, 12)
                        .padding(.vertical, 8)
                    }
                    .onChange(of: filteredLogs.count) { _ in
                        if let last = filteredLogs.indices.last {
                            proxy.scrollTo(last, anchor: .bottom)
                        }
                    }
                }
            }
        }
        .frame(width: 700, height: 500)
        .task { await viewModel.loadDebugLogs() }
        .onChange(of: autoRefresh) { enabled in
            refreshTask?.cancel()
            if enabled {
                refreshTask = Task {
                    while !Task.isCancelled {
                        try? await Task.sleep(nanoseconds: 3_000_000_000)
                        await viewModel.loadDebugLogs()
                    }
                }
            }
        }
        .onDisappear {
            refreshTask?.cancel()
        }
    }

    private func logRow(_ log: APIClient.LogEntry) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Text(formatTimestamp(log.ts))
                .font(.system(.caption2, design: .monospaced))
                .foregroundStyle(.tertiary)
                .frame(width: 70, alignment: .leading)

            levelBadge(log.level)

            Text(log.message)
                .font(.system(.caption, design: .monospaced))
                .foregroundStyle(log.level == "error" ? .red : (log.level == "warn" ? .orange : .primary))
                .textSelection(.enabled)
                .lineLimit(3)
        }
        .padding(.vertical, 2)
    }

    private func levelBadge(_ level: String) -> some View {
        Text(level.uppercased())
            .font(.system(.caption2, design: .monospaced))
            .fontWeight(.semibold)
            .padding(.horizontal, 4)
            .padding(.vertical, 1)
            .background(levelColor(level).opacity(0.15))
            .foregroundStyle(levelColor(level))
            .clipShape(RoundedRectangle(cornerRadius: 3))
            .frame(width: 44)
    }

    private func levelColor(_ level: String) -> Color {
        switch level {
        case "error": .red
        case "warn": .orange
        default: .secondary
        }
    }

    private func formatTimestamp(_ ts: String) -> String {
        // Extract just HH:MM:SS from ISO string
        guard let tIndex = ts.firstIndex(of: "T") else { return ts }
        let timeStart = ts.index(after: tIndex)
        let timePart = String(ts[timeStart...].prefix(8))
        return timePart
    }
}
