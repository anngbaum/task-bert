import Foundation
import EventKit

final class RemindersSyncManager: @unchecked Sendable {
    static let shared = RemindersSyncManager()

    private let store = EKEventStore()
    private let service = SearchService()
    private let listName = "Bert"
    private var observer: NSObjectProtocol?

    /// Called when reminders are completed externally (e.g. in Reminders.app).
    /// Passes the task IDs that were completed.
    var onRemindersCompleted: (([Int]) -> Void)?

    /// Provider of current tasks — set by the ViewModel so the observer always checks fresh data.
    var currentTasksProvider: (() -> [TaskItem])?

    private init() {}

    // MARK: - Observation

    /// Start observing the EventKit store for external changes (e.g. user completes a reminder in Reminders.app).
    func startObserving(tasks: [TaskItem]) {
        stopObserving()

        observer = NotificationCenter.default.addObserver(
            forName: .EKEventStoreChanged,
            object: store,
            queue: nil
        ) { [weak self] _ in
            guard let self else { return }
            let activeTasks = self.currentTasksProvider?() ?? tasks
            self.checkForCompletedReminders(tasks: activeTasks)
        }
    }

    func stopObserving() {
        if let observer {
            NotificationCenter.default.removeObserver(observer)
            self.observer = nil
        }
    }

    /// Check all synced tasks — if the corresponding reminder was completed externally, fire the callback.
    private func checkForCompletedReminders(tasks: [TaskItem]) {
        var completedTaskIds: [Int] = []

        for task in tasks {
            guard let reminderId = task.reminder_id else { continue }
            guard let reminder = store.calendarItem(withIdentifier: reminderId) as? EKReminder else { continue }

            if reminder.isCompleted {
                completedTaskIds.append(task.id)
            }
        }

        if !completedTaskIds.isEmpty {
            onRemindersCompleted?(completedTaskIds)
        }
    }

    // MARK: - Sync

    /// Sync all provided tasks to Reminders. Creates new reminders for tasks without a reminder_id,
    /// and updates existing ones.
    func syncTasks(_ tasks: [TaskItem]) async {
        guard await requestAccess() else { return }

        let list = getOrCreateList()

        for task in tasks {
            if let existingId = task.reminder_id,
               let existing = store.calendarItem(withIdentifier: existingId) as? EKReminder {
                // Update existing reminder if title changed
                if existing.title != task.title {
                    existing.title = task.title
                    try? store.save(existing, commit: false)
                }
            } else {
                // Create new reminder
                let reminder = EKReminder(eventStore: store)
                reminder.title = task.title
                reminder.calendar = list
                reminder.priority = task.isHighPriority ? 1 : 5  // 1=high, 5=medium

                if let date = task.date {
                    let components = Calendar.current.dateComponents([.year, .month, .day, .hour, .minute], from: date)
                    reminder.dueDateComponents = components
                }

                if let notes = task.chat_name {
                    reminder.notes = "From: \(notes)"
                }

                do {
                    try store.save(reminder, commit: false)
                    // Store the reminder ID back to the server
                    try await service.setReminderId(taskId: task.id, reminderId: reminder.calendarItemIdentifier)
                } catch {
                    print("[Reminders] Failed to save reminder for task \(task.id): \(error)")
                }
            }
        }

        try? store.commit()
    }

    /// Remove the reminder associated with a task (when completed or deleted from the app).
    func removeReminder(for task: TaskItem) {
        guard let reminderId = task.reminder_id else { return }
        guard let reminder = store.calendarItem(withIdentifier: reminderId) as? EKReminder else { return }

        do {
            try store.remove(reminder, commit: true)
        } catch {
            print("[Reminders] Failed to remove reminder: \(error)")
        }
    }

    /// Mark the reminder as completed (when task is completed in the app).
    func completeReminder(for task: TaskItem) {
        guard let reminderId = task.reminder_id else { return }
        guard let reminder = store.calendarItem(withIdentifier: reminderId) as? EKReminder else { return }

        reminder.isCompleted = true
        do {
            try store.save(reminder, commit: true)
        } catch {
            print("[Reminders] Failed to complete reminder: \(error)")
        }
    }

    // MARK: - Private

    private func requestAccess() async -> Bool {
        if #available(macOS 14.0, *) {
            do {
                return try await store.requestFullAccessToReminders()
            } catch {
                return false
            }
        } else {
            return await withCheckedContinuation { cont in
                store.requestAccess(to: .reminder) { granted, _ in
                    cont.resume(returning: granted)
                }
            }
        }
    }

    private func getOrCreateList() -> EKCalendar {
        // Look for existing list
        let calendars = store.calendars(for: .reminder)
        if let existing = calendars.first(where: { $0.title == listName }) {
            return existing
        }

        // Create new list
        let calendar = EKCalendar(for: .reminder, eventStore: store)
        calendar.title = listName
        calendar.source = store.defaultCalendarForNewReminders()?.source ?? store.sources.first(where: { $0.sourceType == .local })
        try? store.saveCalendar(calendar, commit: true)
        return calendar
    }
}
