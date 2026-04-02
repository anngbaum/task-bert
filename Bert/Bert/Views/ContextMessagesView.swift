import SwiftUI

struct ContextMessagesView: View {
    let result: SearchResult
    let messages: [ContextMessage]?
    let isLoading: Bool

    private var threadMessages: [ThreadMessage] {
        guard let messages else { return [.fromResult(result)] }

        var thread: [ThreadMessage] = []
        var inserted = false

        for msg in messages {
            if !inserted && msg.id > result.id {
                thread.append(.fromResult(result))
                inserted = true
            }
            thread.append(.fromContext(msg))
        }

        if !inserted {
            thread.append(.fromResult(result))
        }

        return thread
    }

    var body: some View {
        GroupBox {
            if isLoading {
                HStack(spacing: 8) {
                    ProgressView()
                        .controlSize(.small)
                    Text("Loading context...")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                .padding(.vertical, 4)
            } else if let messages, !messages.isEmpty {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(threadMessages) { msg in
                        HStack(alignment: .top, spacing: 6) {
                            Image(systemName: msg.isFromMe ? "arrow.up.circle" : "arrow.down.circle")
                                .font(.caption)
                                .foregroundStyle(msg.isFromMe ? .blue : .secondary)

                            VStack(alignment: .leading, spacing: 1) {
                                HStack(spacing: 4) {
                                    Text(msg.sender)
                                        .font(.caption)
                                        .fontWeight(msg.isHighlighted ? .bold : .medium)
                                    if let date = msg.date {
                                        Text(date.shortFormatted)
                                            .font(.caption2)
                                            .foregroundStyle(msg.isHighlighted ? .primary : .tertiary)
                                    }
                                }
                                Text(msg.text)
                                    .font(.caption)
                                    .foregroundStyle(msg.isHighlighted ? .primary : .secondary)
                                    .lineLimit(msg.isHighlighted ? nil : 2)
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        .padding(.horizontal, 6)
                        .padding(.vertical, 4)
                        .background(
                            msg.isHighlighted
                                ? Color.yellow.opacity(0.45)
                                : Color.clear
                        )
                        .cornerRadius(4)
                    }
                }
            } else {
                Text("No surrounding messages found")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .padding(.vertical, 4)
            }
        }
        .backgroundStyle(.quaternary)
    }
}

private struct ThreadMessage: Identifiable {
    let id: Int
    let text: String
    let date: Date?
    let isFromMe: Bool
    let sender: String
    let isHighlighted: Bool

    static func fromContext(_ msg: ContextMessage) -> ThreadMessage {
        ThreadMessage(
            id: msg.id,
            text: msg.text ?? "(no text)",
            date: msg.date,
            isFromMe: msg.is_from_me,
            sender: msg.displaySender,
            isHighlighted: false
        )
    }

    static func fromResult(_ result: SearchResult) -> ThreadMessage {
        ThreadMessage(
            id: result.id,
            text: result.text,
            date: result.date,
            isFromMe: result.is_from_me,
            sender: result.displaySender,
            isHighlighted: true
        )
    }
}
