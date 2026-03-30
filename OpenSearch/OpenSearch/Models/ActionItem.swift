import Foundation

struct KeyEvent: Identifiable, Decodable {
    let id: Int
    let chat_id: Int
    let message_id: Int?
    let title: String
    let date: Date?
    let location: String?
    let removed: Bool?
    let created_at: Date
    let chat_name: String?
}

struct TaskItem: Identifiable, Decodable {
    let id: Int
    let chat_id: Int
    let message_id: Int?
    let title: String
    let date: Date?
    let priority: String  // "high" or "low"
    let key_event_id: Int?
    let completed: Bool
    let reminder_id: String?
    let created_at: Date
    let chat_name: String?

    var isHighPriority: Bool { priority == "high" }
}

struct AgentProgressStep: Identifiable {
    let id = UUID()
    let eventType: String   // "thinking", "tool_call", "tool_result"
    let description: String
    let tool: String?
    let resultSummary: String?
}
