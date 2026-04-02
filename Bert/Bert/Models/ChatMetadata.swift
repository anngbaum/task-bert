import Foundation

struct ChatMetadata: Identifiable, Decodable {
    let chat_id: Int
    let summary: String
    let last_updated: Date
    let chat_name: String?
    let latest_message_date: Date?
    let participant_count: Int?

    var id: Int { chat_id }
    var isGroupChat: Bool { (participant_count ?? 0) > 1 }
}

struct LeaderboardParticipant: Decodable {
    let identifier: String
    let name: String
}

struct LeaderboardReaction: Decodable {
    let orig_is_from_me: Bool
    let orig_identifier: String?
    let reaction_type: Int
    let emoji: String?
    let cnt: Int
}

struct LeaderboardMessageCount: Decodable {
    let is_from_me: Bool
    let identifier: String?
    let cnt: Int
}

struct LeaderboardResponse: Decodable {
    let participants: [LeaderboardParticipant]
    let reactions: [LeaderboardReaction]
    let message_counts: [LeaderboardMessageCount]
}
