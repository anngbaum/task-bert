import Foundation

struct KeyEvent: Identifiable, Decodable {
    let id: Int
    let chat_id: Int
    let message_id: Int?
    let title: String
    let date: Date?
    let removed: Bool?
    let created_at: Date
    let chat_name: String?
}

struct SuggestedFollowUp: Identifiable, Decodable {
    let id: Int
    let chat_id: Int
    let message_id: Int?
    let title: String
    let date: Date?
    let key_event_id: Int?
    let completed: Bool
    let created_at: Date
    let chat_name: String?
}

struct ActionItem: Identifiable, Decodable {
    let id: Int
    let chat_id: Int
    let message_id: Int
    let title: String
    let date: Date?
    let completed: Bool
    let created_at: Date
    let chat_name: String?
}
