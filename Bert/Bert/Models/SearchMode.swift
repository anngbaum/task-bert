import Foundation

enum SearchMode: String, CaseIterable, Identifiable {
    case text
    case semantic
    case hybrid

    var id: String { rawValue }

    var label: String {
        switch self {
        case .text: "Text"
        case .semantic: "Semantic"
        case .hybrid: "Hybrid"
        }
    }

    var description: String {
        switch self {
        case .text: "Full-text keyword search"
        case .semantic: "AI semantic similarity"
        case .hybrid: "Combined text + semantic"
        }
    }

    var iconName: String {
        switch self {
        case .text: "text.magnifyingglass"
        case .semantic: "brain"
        case .hybrid: "arrow.triangle.merge"
        }
    }
}
