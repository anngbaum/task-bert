import Foundation

struct SearchResult: Codable, Identifiable, Hashable {
    let id: Int
    let text: String
    let date: Date?
    let is_from_me: Bool
    let sender: String?
    let chat_name: String?
    let score: Double
    let rank: Int?
    let link_preview: LinkPreviewDTO?

    var displaySender: String {
        is_from_me ? "Me" : (sender ?? "Unknown")
    }
}
