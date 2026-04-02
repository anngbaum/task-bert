import SwiftUI

struct LeaderboardView: View {
    @ObservedObject var viewModel: SearchViewModel
    let chatName: String

    private let reactionTypes: [(type: Int, label: String, icon: String)] = [
        (2000, "Loved", "\u{2764}\u{FE0F}"),
        (2001, "Liked", "\u{1F44D}"),
        (2002, "Disliked", "\u{1F44E}"),
        (2003, "Laughed", "\u{1F602}"),
        (2004, "Emphasized", "\u{203C}\u{FE0F}"),
        (2005, "Questioned", "\u{2753}"),
    ]

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Header
            HStack {
                Button {
                    withAnimation(.easeInOut(duration: 0.15)) {
                        viewModel.leaderboardChatId = nil
                    }
                } label: {
                    HStack(spacing: 4) {
                        Image(systemName: "chevron.left")
                            .font(.caption)
                        Text("Back")
                            .font(.caption)
                    }
                }
                .buttonStyle(.plain)

                Spacer()

                Text("Leaderboard")
                    .font(.caption)
                    .fontWeight(.semibold)

                Spacer()

                // Balance the back button width
                Color.clear.frame(width: 50, height: 1)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)

            Divider()

            if viewModel.isLoadingLeaderboard {
                VStack(spacing: 12) {
                    ProgressView()
                    Text("Loading leaderboard...")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let data = viewModel.leaderboardData {
                ScrollView {
                    VStack(alignment: .leading, spacing: 12) {
                        Text(chatName)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .padding(.horizontal, 12)
                            .padding(.top, 8)

                        let entries = buildEntries(data: data)

                        ForEach(entries) { entry in
                            LeaderboardEntryView(
                                entry: entry,
                                reactionTypes: reactionTypes,
                                customEmojis: customEmojis(for: entry, data: data)
                            )
                        }
                    }
                    .padding(.horizontal, 12)
                    .padding(.bottom, 8)
                }
            } else {
                VStack(spacing: 12) {
                    Image(systemName: "chart.bar")
                        .font(.system(size: 48))
                        .foregroundStyle(.tertiary)
                    Text("No reaction data")
                        .font(.title3)
                        .foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
    }

    private func buildEntries(data: LeaderboardResponse) -> [LeaderboardEntry] {
        var entries: [LeaderboardEntry] = []

        // Build message count lookup
        let myMessages = data.message_counts.filter { $0.is_from_me }.reduce(0) { $0 + $1.cnt }
        var handleMessageCounts: [Int: Int] = [:]
        for mc in data.message_counts where !mc.is_from_me {
            if let hid = mc.handle_id {
                handleMessageCounts[hid, default: 0] += mc.cnt
            }
        }

        // "Me" entry
        let myReactions = data.reactions.filter { $0.orig_is_from_me }
        var myCounts: [Int: Int] = [:]
        for r in myReactions {
            myCounts[r.reaction_type, default: 0] += r.cnt
        }
        let myTotal = myCounts.values.reduce(0, +)
        if myTotal > 0 || myMessages > 0 {
            entries.append(LeaderboardEntry(id: -1, name: "Me", reactionCounts: myCounts, totalReactions: myTotal, messageCount: myMessages))
        }

        // Other participants
        for participant in data.participants {
            let reactions = data.reactions.filter { !$0.orig_is_from_me && $0.orig_handle_id == participant.handle_id }
            var counts: [Int: Int] = [:]
            for r in reactions {
                counts[r.reaction_type, default: 0] += r.cnt
            }
            let total = counts.values.reduce(0, +)
            let msgCount = handleMessageCounts[participant.handle_id] ?? 0
            if total > 0 || msgCount > 0 {
                entries.append(LeaderboardEntry(id: participant.handle_id, name: participant.name, reactionCounts: counts, totalReactions: total, messageCount: msgCount))
            }
        }

        // Sort by total reactions descending
        entries.sort { $0.totalReactions > $1.totalReactions }
        return entries
    }

    private func customEmojis(for entry: LeaderboardEntry, data: LeaderboardResponse) -> [String: Int] {
        let reactions: [LeaderboardReaction]
        if entry.id == -1 {
            reactions = data.reactions.filter { $0.orig_is_from_me && $0.reaction_type == 2006 }
        } else {
            reactions = data.reactions.filter { !$0.orig_is_from_me && $0.orig_handle_id == entry.id && $0.reaction_type == 2006 }
        }
        var result: [String: Int] = [:]
        for r in reactions {
            if let emoji = r.emoji {
                result[emoji, default: 0] += r.cnt
            }
        }
        return result
    }
}

struct LeaderboardEntry: Identifiable {
    let id: Int
    let name: String
    let reactionCounts: [Int: Int]  // reaction_type -> count
    let totalReactions: Int
    let messageCount: Int
}

struct LeaderboardEntryView: View {
    let entry: LeaderboardEntry
    let reactionTypes: [(type: Int, label: String, icon: String)]
    let customEmojis: [String: Int]

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(entry.name)
                    .font(.caption)
                    .fontWeight(.semibold)

                Spacer()

                HStack(spacing: 8) {
                    Label("\(entry.messageCount)", systemImage: "text.bubble")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                    Text("\(entry.totalReactions) reactions")
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }
            }

            // Standard reactions
            let activeReactions = reactionTypes.filter { entry.reactionCounts[$0.type] != nil }
            if !activeReactions.isEmpty {
                HStack(spacing: 10) {
                    ForEach(activeReactions, id: \.type) { reaction in
                        HStack(spacing: 3) {
                            Text(reaction.icon)
                                .font(.caption)
                            Text("\(entry.reactionCounts[reaction.type]!)")
                                .font(.caption2)
                                .fontWeight(.medium)
                                .foregroundStyle(.secondary)
                        }
                    }
                }
            }

            // Custom emoji reactions (top 5)
            if !customEmojis.isEmpty {
                let sorted = customEmojis.sorted { $0.value > $1.value }.prefix(5)
                HStack(spacing: 10) {
                    ForEach(Array(sorted), id: \.key) { emoji, count in
                        HStack(spacing: 3) {
                            Text(emoji)
                                .font(.caption)
                            Text("\(count)")
                                .font(.caption2)
                                .fontWeight(.medium)
                                .foregroundStyle(.secondary)
                        }
                    }
                }
            }
        }
        .padding(.vertical, 6)
        .padding(.horizontal, 8)
        .background(Color.primary.opacity(0.03))
        .cornerRadius(6)
    }
}
