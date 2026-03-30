import Foundation

enum TimePreset: String, CaseIterable, Identifiable, Equatable {
    case past90Days = "Last 90 Days"
    case thisWeek = "This Week"
    case lastWeek = "Last Week"
    case yesterday = "Yesterday"

    var id: String { rawValue }

    var dateRange: (after: Date, before: Date) {
        let cal = Calendar.current
        let now = Date()
        let today = cal.startOfDay(for: now)

        switch self {
        case .past90Days:
            let ninetyDaysAgo = cal.date(byAdding: .day, value: -90, to: today)!
            return (ninetyDaysAgo, now)
        case .thisWeek:
            let weekStart = cal.date(from: cal.dateComponents([.yearForWeekOfYear, .weekOfYear], from: today))!
            return (weekStart, now)
        case .lastWeek:
            let thisWeekStart = cal.date(from: cal.dateComponents([.yearForWeekOfYear, .weekOfYear], from: today))!
            let lastWeekStart = cal.date(byAdding: .day, value: -7, to: thisWeekStart)!
            return (lastWeekStart, thisWeekStart)
        case .yesterday:
            let yesterday = cal.date(byAdding: .day, value: -1, to: today)!
            return (yesterday, today)
        }
    }
}

struct SearchFilters: Equatable {
    /// Contacts whose conversations to search (any message in a chat with them)
    var withContacts: [Contact] = []
    /// Contacts who are the actual sender of the message
    var sentByContacts: [Contact] = []
    var sentByMe: Bool = false
    var groupChat: GroupChat? = nil
    var timePreset: TimePreset? = .past90Days
    var afterDate: Date? = nil
    var beforeDate: Date? = nil

    var isActive: Bool {
        !withContacts.isEmpty || !sentByContacts.isEmpty || sentByMe ||
        groupChat != nil || timePreset != nil || afterDate != nil || beforeDate != nil
    }

    var withString: String {
        withContacts.map(\.name).joined(separator: ", ")
    }

    var sentByString: String {
        sentByContacts.map(\.name).joined(separator: ", ")
    }

    /// Effective date range: custom dates override preset
    var effectiveAfterDate: Date? {
        afterDate ?? timePreset?.dateRange.after
    }

    var effectiveBeforeDate: Date? {
        beforeDate ?? timePreset?.dateRange.before
    }

    /// Returns true if the user has set custom dates (not from a preset)
    var isCustomDateRange: Bool {
        afterDate != nil || beforeDate != nil
    }

    mutating func applyPreset(_ preset: TimePreset) {
        timePreset = preset
        afterDate = preset.dateRange.after
        beforeDate = preset.dateRange.before
    }

    mutating func clearDates() {
        timePreset = nil
        afterDate = nil
        beforeDate = nil
    }

    mutating func reset() {
        withContacts = []
        sentByContacts = []
        sentByMe = false
        groupChat = nil
        timePreset = .past90Days
        afterDate = TimePreset.past90Days.dateRange.after
        beforeDate = TimePreset.past90Days.dateRange.before
    }
}
