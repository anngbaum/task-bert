import Foundation

struct Contact: Codable, Identifiable, Hashable {
    let name: String
    let identifiers: [String]

    var id: String { name }

    /// Display string for subtitle (e.g. "+1234, email@example.com")
    var identifierSummary: String {
        identifiers.joined(separator: ", ")
    }
}
