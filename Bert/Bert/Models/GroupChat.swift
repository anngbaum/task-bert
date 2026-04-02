import Foundation

struct GroupChat: Codable, Identifiable, Hashable {
    let name: String
    let chatIdentifier: String

    var id: String { chatIdentifier }
}
