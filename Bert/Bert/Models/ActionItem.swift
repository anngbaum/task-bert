import Foundation

struct KeyEvent: Identifiable, Decodable {
    let id: Int
    let chat_id: Int
    let message_id: Int?
    var title: String
    var date: Date?
    var location: String?
    let removed: Bool?
    let created_at: Date
    let chat_name: String?

    /// Formatted time string, or nil for all-day events (stored as noon by convention).
    var formattedTime: String? {
        guard let date else { return nil }
        let comps = Calendar.current.dateComponents([.hour, .minute], from: date)
        if comps.hour == 12 && comps.minute == 0 { return nil }
        return date.formatted(.dateTime.hour().minute())
    }
}

struct TaskItem: Identifiable, Decodable {
    let id: Int
    let chat_id: Int
    let message_id: Int?
    let title: String
    var date: Date?
    var priority: String  // "high" or "low"
    var type: String  // "action" or "waiting"
    let trigger_hint: String?
    var bucket: String?  // "todo", "upcoming", or "waiting" — computed by server
    let completed: Bool
    let reminder_id: String?
    let created_at: Date
    let chat_name: String?

    var isHighPriority: Bool { priority == "high" }

    var resolvedBucket: String {
        if let bucket { return bucket }
        if type == "waiting" { return "waiting" }
        if type == "action", let date, date > Calendar.current.startOfDay(for: Date()).addingTimeInterval(86400) { return "upcoming" }
        return "todo"
    }
}

struct AgentProgressStep: Identifiable {
    let id = UUID()
    let eventType: String   // "thinking", "tool_call", "tool_result"
    let description: String
    let tool: String?
    let resultSummary: String?
}
