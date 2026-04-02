import Foundation

extension Date {
    var shortFormatted: String {
        let formatter = DateFormatter()
        formatter.dateStyle = .medium
        formatter.timeStyle = .short
        return formatter.string(from: self)
    }

    var dayFormatted: String {
        let formatter = DateFormatter()
        formatter.dateStyle = .medium
        formatter.timeStyle = .none
        return formatter.string(from: self)
    }

    var timeFormatted: String {
        let formatter = DateFormatter()
        formatter.dateStyle = .none
        formatter.timeStyle = .short
        return formatter.string(from: self)
    }

    var chatDateFormatted: String {
        let cal = Calendar.current
        let time = self.timeFormatted
        if cal.isDateInToday(self) {
            return "Today at \(time)"
        } else if cal.isDateInYesterday(self) {
            return "Yesterday at \(time)"
        } else {
            let formatter = DateFormatter()
            formatter.dateFormat = "EEEE MMMM d"
            return "\(formatter.string(from: self)) at \(time)"
        }
    }
}
