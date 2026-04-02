import Foundation

struct ContextMessage: Codable, Identifiable {
    let id: Int
    let text: String?
    let date: Date?
    let is_from_me: Bool
    let sender: String?

    var displaySender: String {
        is_from_me ? "Me" : (sender ?? "Unknown")
    }
}
