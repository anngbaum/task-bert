import Foundation

struct ThreadChatInfo: Codable {
    let chat_id: Int
    let display_name: String?
    let chat_identifier: String
    let participants: [String]
}

struct LinkPreviewDTO: Codable, Hashable {
    let original_url: String
    let canonical_url: String?
    let title: String?
    let summary: String?
    let item_type: String?
    let author: String?
}

struct ThreadMessageDTO: Codable, Identifiable {
    let id: Int
    let text: String?
    let date: Date?
    let is_from_me: Bool
    let sender: String?
    let service: String?
    let thread_originator_guid: String?
    let has_attachments: Bool
    let link_preview: LinkPreviewDTO?

    var displaySender: String {
        is_from_me ? "Me" : (sender ?? "Unknown")
    }
}

struct ThreadCursors: Codable {
    let older: String?
    let newer: String?
}

struct ThreadResponse: Codable {
    let chat: ThreadChatInfo
    let anchor_message_id: Int
    let messages: [ThreadMessageDTO]
    let cursors: ThreadCursors
    let has_older: Bool
    let has_newer: Bool
}
