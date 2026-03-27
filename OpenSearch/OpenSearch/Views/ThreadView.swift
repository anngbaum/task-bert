import SwiftUI

struct ThreadView: View {
    @ObservedObject var viewModel: SearchViewModel

    var body: some View {
        VStack(spacing: 0) {
            // Header bar
            threadHeader

            Divider()

            // Thread content
            if viewModel.isLoadingThread {
                VStack(spacing: 12) {
                    ProgressView()
                    Text("Loading conversation...")
                        .foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let error = viewModel.threadError {
                VStack(spacing: 12) {
                    Image(systemName: "exclamationmark.triangle")
                        .font(.largeTitle)
                        .foregroundStyle(.orange)
                    Text(error)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .padding()
            } else if let response = viewModel.threadResponse {
                threadContent(response)
            }
        }
    }

    private var threadHeader: some View {
        HStack {
            Button(action: { viewModel.closeThread() }) {
                Label("Back to Results", systemImage: "chevron.left")
                    .labelStyle(.titleAndIcon)
            }
            .buttonStyle(.plain)
            .foregroundStyle(.blue)

            Spacer()

            if let response = viewModel.threadResponse {
                VStack(alignment: .trailing, spacing: 1) {
                    Text(response.chat.display_name ?? response.chat.chat_identifier)
                        .font(.headline)
                    if !response.chat.participants.isEmpty {
                        Text(response.chat.participants.joined(separator: ", "))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                }
            }
        }
        .padding(.horizontal)
        .padding(.vertical, 10)
    }

    private func threadContent(_ response: ThreadResponse) -> some View {
        ScrollViewReader { proxy in
            List {
                // Load older button
                if response.has_older {
                    loadMoreButton(direction: "older")
                }

                ForEach(response.messages) { msg in
                    threadMessageRow(msg, anchorId: response.anchor_message_id)
                        .id(msg.id)
                }

                // Load newer button
                if response.has_newer {
                    loadMoreButton(direction: "newer")
                }
            }
            .listStyle(.plain)
            .onAppear {
                // Delay slightly to let List finish layout before scrolling
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
                    withAnimation(.easeInOut(duration: 0.3)) {
                        proxy.scrollTo(response.anchor_message_id, anchor: .center)
                    }
                }
            }
            .onChange(of: response.anchor_message_id) { newAnchor in
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
                    withAnimation(.easeInOut(duration: 0.3)) {
                        proxy.scrollTo(newAnchor, anchor: .center)
                    }
                }
            }
        }
    }

    private func threadMessageRow(_ msg: ThreadMessageDTO, anchorId: Int) -> some View {
        let isAnchor = msg.id == anchorId

        return HStack(alignment: .top, spacing: 8) {
            Image(systemName: msg.is_from_me ? "arrow.up.circle.fill" : "arrow.down.circle.fill")
                .font(.caption)
                .foregroundStyle(msg.is_from_me ? .blue : .secondary)
                .padding(.top, 2)

            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 4) {
                    Text(msg.displaySender)
                        .font(.subheadline)
                        .fontWeight(isAnchor ? .bold : .medium)
                    if let date = msg.date {
                        Text(date.shortFormatted)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    if msg.has_attachments {
                        Image(systemName: "paperclip")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                }
                Text(msg.text ?? "(no text)")
                    .font(.body)
                    .foregroundStyle(isAnchor ? .primary : .secondary)

                if let lp = msg.link_preview {
                    linkPreviewCard(lp)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.vertical, 4)
        .padding(.horizontal, 6)
        .background(isAnchor ? Color.yellow.opacity(0.3) : Color.clear)
        .cornerRadius(6)
    }

    private func linkPreviewCard(_ lp: LinkPreviewDTO) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            if let title = lp.title {
                Text(title)
                    .font(.subheadline)
                    .fontWeight(.semibold)
                    .lineLimit(2)
            }
            if let summary = lp.summary {
                Text(summary)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(3)
            }
            HStack(spacing: 4) {
                Image(systemName: "link")
                    .font(.caption2)
                if let host = URL(string: lp.original_url)?.host {
                    Text(host)
                        .font(.caption2)
                } else {
                    Text(lp.original_url)
                        .font(.caption2)
                        .lineLimit(1)
                }
                if let author = lp.author {
                    Text("· \(author)")
                        .font(.caption2)
                }
            }
            .foregroundStyle(.blue)
        }
        .padding(8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(nsColor: .controlBackgroundColor))
        .cornerRadius(8)
        .overlay(
            RoundedRectangle(cornerRadius: 8)
                .stroke(Color(nsColor: .separatorColor), lineWidth: 0.5)
        )
        .onTapGesture {
            if let url = URL(string: lp.original_url) {
                NSWorkspace.shared.open(url)
            }
        }
    }

    private func loadMoreButton(direction: String) -> some View {
        Button {
            Task { await viewModel.loadMoreThread(direction: direction) }
        } label: {
            HStack(spacing: 6) {
                if viewModel.isLoadingMoreThread {
                    ProgressView()
                        .controlSize(.small)
                }
                Text(direction == "older" ? "Load older messages..." : "Load newer messages...")
                    .font(.caption)
                    .foregroundStyle(.blue)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 6)
        }
        .buttonStyle(.plain)
        .disabled(viewModel.isLoadingMoreThread)
    }
}
