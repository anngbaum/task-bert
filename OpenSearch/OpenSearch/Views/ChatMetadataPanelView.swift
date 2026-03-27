import SwiftUI

struct ChatMetadataPanelView: View {
    @ObservedObject var viewModel: SearchViewModel

    var body: some View {
        Group {
            if viewModel.isLoadingMetadata {
                VStack(spacing: 12) {
                    ProgressView()
                    Text("Loading conversations...")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if viewModel.chatMetadata.isEmpty {
                VStack(spacing: 12) {
                    Image(systemName: "bubble.left.and.text.bubble.right")
                        .font(.system(size: 48))
                        .foregroundStyle(.tertiary)
                    Text("No recent conversation summaries")
                        .font(.title3)
                        .foregroundStyle(.secondary)
                    Text("Sync to generate summaries")
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ScrollView {
                    VStack(alignment: .leading, spacing: 6) {
                        ForEach(viewModel.chatMetadata) { meta in
                            ChatMetadataRowView(
                                metadata: meta,
                                isRefreshing: viewModel.refreshingMetadataChats.contains(meta.chat_id)
                            ) {
                                Task { await viewModel.refreshChatMetadata(chatId: meta.chat_id) }
                            }
                        }
                    }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                }
            }
        }
        .onAppear {
            Task { await viewModel.loadChatMetadata() }
        }
    }
}

struct ChatMetadataRowView: View {
    let metadata: ChatMetadata
    let isRefreshing: Bool
    let onRefresh: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Label(metadata.chat_name ?? "Unknown Chat", systemImage: "bubble.left")
                    .font(.caption)
                    .fontWeight(.medium)
                    .lineLimit(1)

                Spacer()

                Text((metadata.latest_message_date ?? metadata.last_updated).chatDateFormatted)
                    .font(.caption2)
                    .foregroundStyle(.tertiary)

                Button(action: onRefresh) {
                    if isRefreshing {
                        ProgressView()
                            .controlSize(.mini)
                    } else {
                        Image(systemName: "arrow.clockwise")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                }
                .buttonStyle(.plain)
                .disabled(isRefreshing)
                .help("Refresh summary")
            }

            Text(metadata.summary)
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(3)
        }
        .padding(.vertical, 6)
        .padding(.horizontal, 8)
        .background(Color.primary.opacity(0.03))
        .cornerRadius(6)
    }
}
