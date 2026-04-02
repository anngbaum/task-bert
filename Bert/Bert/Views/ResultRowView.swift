import SwiftUI

struct ResultRowView: View {
    let result: SearchResult

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Label(result.displaySender, systemImage: result.is_from_me ? "arrow.up.circle" : "arrow.down.circle")
                    .font(.headline)
                    .foregroundStyle(result.is_from_me ? .blue : .primary)

                if let chatName = result.chat_name, !chatName.isEmpty {
                    Text(chatName.hasPrefix("to ") ? chatName : "in \(chatName)")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }

                Spacer()

                Text(String(format: "%.4f", result.score))
                    .font(.caption)
                    .foregroundStyle(.tertiary)
                    .monospacedDigit()
            }

            Text(result.text)
                .font(.body)
                .lineLimit(3)

            if let lp = result.link_preview {
                linkPreviewCard(lp)
            }

            if let date = result.date {
                Text(date.shortFormatted)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 4)
    }

    private func linkPreviewCard(_ lp: LinkPreviewDTO) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            if let title = lp.title {
                Text(title)
                    .font(.caption)
                    .fontWeight(.semibold)
                    .lineLimit(1)
            }
            if let summary = lp.summary {
                Text(summary)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
            HStack(spacing: 3) {
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
            }
            .foregroundStyle(.blue)
        }
        .padding(6)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(nsColor: .controlBackgroundColor))
        .cornerRadius(6)
        .overlay(
            RoundedRectangle(cornerRadius: 6)
                .stroke(Color(nsColor: .separatorColor), lineWidth: 0.5)
        )
    }
}
