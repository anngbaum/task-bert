import SwiftUI
import EventKit

struct ActionsPanelView: View {
    @ObservedObject var viewModel: SearchViewModel
    @State private var expandedSections: Set<String> = ["todo", "upcoming", "waiting"]

    private var todoTasks: [TaskItem] {
        viewModel.tasks.filter { $0.resolvedBucket == "todo" }
    }

    private var upcomingTasks: [TaskItem] {
        viewModel.tasks.filter { $0.resolvedBucket == "upcoming" }
    }

    private var waitingTasks: [TaskItem] {
        viewModel.tasks.filter { $0.resolvedBucket == "waiting" }
    }

    var body: some View {
        Group {
            if viewModel.isLoadingActions {
                VStack(spacing: 12) {
                    ProgressView()
                    Text("Loading...")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if viewModel.tasks.isEmpty && viewModel.completedTasks.isEmpty {
                VStack(spacing: 12) {
                    Image(systemName: "checklist")
                        .font(.system(size: 48))
                        .foregroundStyle(.tertiary)
                    Text("No items yet")
                        .font(.title3)
                        .foregroundStyle(.secondary)
                    Text("Tasks and events will appear here after syncing")
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                        .multilineTextAlignment(.center)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ScrollViewReader { proxy in
                    ScrollView {
                        VStack(alignment: .leading, spacing: 12) {
                            // To Do
                            taskSection(
                                bucket: "todo",
                                title: "To Do",
                                icon: "checklist",
                                color: .orange,
                                tasks: todoTasks,
                                accentColor: { _ in .orange }
                            )

                            // Upcoming
                            taskSection(
                                bucket: "upcoming",
                                title: "Upcoming",
                                icon: "calendar.badge.clock",
                                color: .purple,
                                tasks: upcomingTasks,
                                accentColor: { _ in .purple }
                            )

                            // Waiting
                            taskSection(
                                bucket: "waiting",
                                title: "Waiting",
                                icon: "hourglass",
                                color: .secondary,
                                tasks: waitingTasks,
                                accentColor: { _ in .secondary }
                            )

                            // All caught up
                            if todoTasks.isEmpty {
                                Text("All caught up!")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                    .padding(.vertical, 8)
                            }

                            // Completed toggle
                            let archivedTotal = viewModel.completedTasks.count
                            if archivedTotal > 0 || viewModel.showCompletedActions {
                                Button {
                                    withAnimation(.easeInOut(duration: 0.2)) {
                                        viewModel.showCompletedActions.toggle()
                                    }
                                    if viewModel.showCompletedActions && archivedTotal == 0 {
                                        Task { await viewModel.loadCompletedActions() }
                                    }
                                } label: {
                                    HStack(spacing: 4) {
                                        Image(systemName: "chevron.right")
                                            .font(.system(size: 8))
                                            .rotationEffect(.degrees(viewModel.showCompletedActions ? 90 : 0))
                                        Text("Completed (\(archivedTotal))")
                                            .font(.caption2)
                                        Spacer()
                                    }
                                    .foregroundStyle(.secondary)
                                    .contentShape(Rectangle())
                                }
                                .buttonStyle(.plain)
                                .padding(.top, 4)
                            }

                            if viewModel.showCompletedActions {
                                if !viewModel.completedTasks.isEmpty {
                                    ForEach(viewModel.completedTasks) { task in
                                        CompletedRowView(title: task.title, chatName: task.chat_name)
                                    }
                                }
                            }
                        }
                        .padding(.horizontal, 12)
                        .padding(.vertical, 8)
                    }
                }
            }
        }
        .onAppear {
            Task {
                await viewModel.loadActions()
                await viewModel.loadCompletedActions()
            }
        }
    }

    @ViewBuilder
    private func taskSection(
        bucket: String,
        title: String,
        icon: String,
        color: Color,
        tasks: [TaskItem],
        accentColor: @escaping (TaskItem) -> Color
    ) -> some View {
        DroppableSectionView(
            bucket: bucket,
            title: title,
            icon: icon,
            color: color,
            tasks: tasks,
            isExpanded: expandedSections.contains(bucket),
            onToggle: { toggleSection(bucket) },
            accentColor: accentColor,
            viewModel: viewModel
        )
    }

    private func toggleSection(_ key: String) {
        withAnimation(.easeInOut(duration: 0.2)) {
            if expandedSections.contains(key) {
                expandedSections.remove(key)
            } else {
                expandedSections.insert(key)
            }
        }
    }
}

struct DroppableSectionView: View {
    let bucket: String
    let title: String
    let icon: String
    let color: Color
    let tasks: [TaskItem]
    let isExpanded: Bool
    let onToggle: () -> Void
    let accentColor: (TaskItem) -> Color
    @ObservedObject var viewModel: SearchViewModel
    @State private var isTargeted = false
    @State private var pendingMoveTaskId: Int? = nil
    @State private var upcomingDate: Date = Date().addingTimeInterval(7 * 24 * 60 * 60)

    var body: some View {
        CollapsibleSection(
            title: title,
            icon: icon,
            color: color,
            count: tasks.count,
            isExpanded: isExpanded || tasks.isEmpty,
            onToggle: tasks.isEmpty ? {} : onToggle
        ) {
            ForEach(tasks) { task in
                TaskRowView(
                    task: task,
                    accentColor: accentColor(task),
                    onComplete: { await viewModel.completeTask(id: task.id) },
                    onTap: task.message_id.map { msgId in
                        { Task { await viewModel.openThread(for: msgId) } }
                    },
                    onTogglePriority: {
                        await viewModel.toggleTaskPriority(id: task.id)
                    }
                )
                .draggable("task:\(task.id)")
            }
        }
        .background(
            RoundedRectangle(cornerRadius: 8)
                .fill(isTargeted ? color.opacity(0.1) : Color.clear)
        )
        .dropDestination(for: String.self) { items, _ in
            guard let item = items.first, item.hasPrefix("task:"),
                  let taskId = Int(item.dropFirst(5)) else { return false }
            if viewModel.tasks.first(where: { $0.id == taskId })?.resolvedBucket == bucket { return false }
            if bucket == "upcoming" {
                upcomingDate = Date().addingTimeInterval(7 * 24 * 60 * 60)
                pendingMoveTaskId = taskId
            } else {
                Task { await viewModel.moveTask(id: taskId, toBucket: bucket) }
            }
            return true
        } isTargeted: { targeted in
            withAnimation(.easeInOut(duration: 0.15)) {
                isTargeted = targeted
            }
        }
        .sheet(item: $pendingMoveTaskId) { taskId in
            UpcomingDatePickerSheet(
                date: $upcomingDate,
                taskTitle: viewModel.tasks.first(where: { $0.id == taskId })?.title ?? "Task",
                onConfirm: {
                    let date = upcomingDate
                    pendingMoveTaskId = nil
                    Task { await viewModel.moveTask(id: taskId, toBucket: "upcoming", date: date) }
                },
                onCancel: {
                    pendingMoveTaskId = nil
                }
            )
        }
    }
}

// Make Int work with .sheet(item:)
extension Int: @retroactive Identifiable {
    public var id: Int { self }
}

struct UpcomingDatePickerSheet: View {
    @Binding var date: Date
    let taskTitle: String
    let onConfirm: () -> Void
    let onCancel: () -> Void

    var body: some View {
        VStack(spacing: 16) {
            Text("When should this move to your to-do list?")
                .font(.headline)

            Text(taskTitle)
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(2)

            DatePicker("", selection: $date, in: Date()..., displayedComponents: .date)
                .labelsHidden()
                .datePickerStyle(.graphical)
                .frame(maxWidth: 300)

            HStack(spacing: 12) {
                Button("Cancel", action: onCancel)
                    .buttonStyle(.bordered)
                Button("Confirm", action: onConfirm)
                    .buttonStyle(.borderedProminent)
            }
        }
        .padding(20)
        .frame(width: 340)
    }
}

struct CollapsibleSection<Content: View>: View {
    let title: String
    let icon: String
    let color: Color
    let count: Int
    let isExpanded: Bool
    let onToggle: () -> Void
    @ViewBuilder let content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button(action: onToggle) {
                HStack(spacing: 4) {
                    Image(systemName: "chevron.right")
                        .font(.system(size: 8, weight: .bold))
                        .foregroundStyle(.secondary)
                        .rotationEffect(.degrees(isExpanded ? 90 : 0))
                    Image(systemName: icon)
                        .font(.system(size: 10))
                        .foregroundStyle(color)
                    Text(title)
                        .font(.caption)
                        .fontWeight(.semibold)
                        .foregroundStyle(.secondary)
                    Text("\(count)")
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                    Spacer()
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .padding(.top, 4)

            if isExpanded {
                content
                    .padding(.top, 4)
            }
        }
    }
}

struct TaskRowView: View {
    let task: TaskItem
    let accentColor: Color
    let onComplete: () async -> Void
    let onTap: (() -> Void)?
    let onTogglePriority: (() async -> Void)?
    @State private var markedDone = false

    private var resolvedAccent: Color {
        task.isHighPriority ? accentColor : accentColor.opacity(0.5)
    }

    var body: some View {
        HStack(alignment: .center, spacing: 6) {
            // Priority indicator
            if let onTogglePriority {
                Button {
                    Task { await onTogglePriority() }
                } label: {
                    Text("!!")
                        .font(.system(size: 10, weight: .black))
                        .foregroundStyle(task.isHighPriority ? accentColor : .clear)
                        .frame(width: 16)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .help(task.isHighPriority ? "Set to low priority" : "Set to high priority")
            }

            VStack(alignment: .leading, spacing: 2) {
                Text(task.title)
                    .font(.caption)
                    .lineLimit(2)
                    .strikethrough(markedDone)
                    .opacity(markedDone ? 0.5 : 1)

                HStack(spacing: 8) {
                    if let chatName = task.chat_name {
                        Label(chatName, systemImage: "bubble.left")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                    if let date = task.date {
                        Label(dueDateText(date), systemImage: "calendar")
                            .font(.caption2)
                            .foregroundStyle(isPastDue(date) ? .red : .secondary)
                    }
                }
                .opacity(markedDone ? 0.5 : 1)
            }

            Spacer(minLength: 0)

            Button {
                withAnimation(.easeInOut(duration: 0.2)) {
                    markedDone = true
                }
                Task {
                    try? await Task.sleep(nanoseconds: 400_000_000)
                    await onComplete()
                }
            } label: {
                Image(systemName: markedDone ? "checkmark.circle.fill" : "circle")
                    .font(.system(size: 20))
                    .foregroundStyle(markedDone ? .green : resolvedAccent)
                    .frame(width: 32, height: 32)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help("Mark as done")
            .disabled(markedDone)
        }
        .padding(.vertical, 4)
        .padding(.horizontal, 6)
        .background(Color.primary.opacity(0.03))
        .cornerRadius(6)
        .contentShape(Rectangle())
        .onTapGesture {
            onTap?()
        }
    }

    private func dueDateText(_ date: Date) -> String {
        let cal = Calendar.current
        if cal.isDateInToday(date) {
            return "Today"
        } else if cal.isDateInTomorrow(date) {
            return "Tomorrow"
        } else {
            return date.dayFormatted
        }
    }

    private func isPastDue(_ date: Date) -> Bool {
        date < Date() && !Calendar.current.isDateInToday(date)
    }
}

struct EventRowView: View {
    let event: KeyEvent
    let viewModel: SearchViewModel
    @State private var isDeleted = false
    @State private var calendarMessage: String?
    @State private var showCalendarPopover = false

    var body: some View {
        HStack(alignment: .center, spacing: 8) {
            VStack(alignment: .leading, spacing: 2) {
                Text(event.title)
                    .font(.caption)
                    .lineLimit(2)

                HStack(spacing: 8) {
                    if let chatName = event.chat_name {
                        Label(chatName, systemImage: "bubble.left")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                    if let date = event.date {
                        Label(eventDateText(date), systemImage: "calendar")
                            .font(.caption2)
                            .foregroundStyle(.purple)
                    }
                    if let location = event.location {
                        Label(location, systemImage: "mappin")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                }

                if let msg = calendarMessage {
                    Text(msg)
                        .font(.caption2)
                        .foregroundStyle(msg.contains("Failed") || msg.contains("denied") ? .red : .green)
                }
            }

            Spacer(minLength: 0)

            if event.date != nil {
                Button {
                    showCalendarPopover = true
                } label: {
                    Image(systemName: "calendar.badge.plus")
                        .font(.system(size: 14))
                        .foregroundStyle(.purple)
                        .frame(width: 28, height: 28)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .help("Add to Calendar")
                .popover(isPresented: $showCalendarPopover, arrowEdge: .trailing) {
                    CalendarPopoverView(
                        event: event,
                        onAddApple: {
                            showCalendarPopover = false
                            addToAppleCalendar()
                        },
                        onAddGoogle: {
                            showCalendarPopover = false
                            openGoogleCalendar()
                        }
                    )
                }
            }

            Button {
                withAnimation(.easeInOut(duration: 0.2)) {
                    isDeleted = true
                }
                Task {
                    try? await Task.sleep(nanoseconds: 300_000_000)
                    await viewModel.deleteEvent(id: event.id)
                }
            } label: {
                Image(systemName: "xmark.circle")
                    .font(.system(size: 14))
                    .foregroundStyle(.secondary)
                    .frame(width: 28, height: 28)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help("Remove event")
        }
        .opacity(isDeleted ? 0.3 : 1)
        .padding(.vertical, 4)
        .padding(.horizontal, 6)
        .background(Color.primary.opacity(0.03))
        .cornerRadius(6)
        .contentShape(Rectangle())
        .onTapGesture {
            if let messageId = event.message_id {
                Task { await viewModel.openThread(for: messageId) }
            }
        }
    }

    private func addToAppleCalendar() {
        guard let date = event.date else { return }
        let store = EKEventStore()

        let saveEvent = {
            let calEvent = EKEvent(eventStore: store)
            calEvent.title = event.title
            calEvent.startDate = date
            calEvent.endDate = date.addingTimeInterval(3600)
            calEvent.location = event.location
            calEvent.calendar = store.defaultCalendarForNewEvents
            do {
                try store.save(calEvent, span: .thisEvent)
                DispatchQueue.main.async {
                    calendarMessage = "Added to Calendar"
                    DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
                        calendarMessage = nil
                    }
                }
            } catch {
                DispatchQueue.main.async {
                    calendarMessage = "Failed to add"
                }
            }
        }

        let handleDenied = {
            DispatchQueue.main.async {
                calendarMessage = "Calendar access denied"
            }
        }

        if #available(macOS 14.0, *) {
            store.requestFullAccessToEvents { granted, error in
                guard granted, error == nil else { handleDenied(); return }
                saveEvent()
            }
        } else {
            store.requestAccess(to: .event) { granted, error in
                guard granted, error == nil else { handleDenied(); return }
                saveEvent()
            }
        }
    }

    private func openGoogleCalendar() {
        guard let date = event.date else { return }
        let endDate = date.addingTimeInterval(3600)

        let fmt = DateFormatter()
        fmt.dateFormat = "yyyyMMdd'T'HHmmss"
        fmt.timeZone = .current

        var components = URLComponents(string: "https://calendar.google.com/calendar/render")!
        components.queryItems = [
            URLQueryItem(name: "action", value: "TEMPLATE"),
            URLQueryItem(name: "text", value: event.title),
            URLQueryItem(name: "dates", value: "\(fmt.string(from: date))/\(fmt.string(from: endDate))"),
            URLQueryItem(name: "ctz", value: TimeZone.current.identifier),
        ]
        if let location = event.location {
            components.queryItems?.append(URLQueryItem(name: "location", value: location))
        }
        if let url = components.url {
            NSWorkspace.shared.open(url)
        }
    }

    private func eventDateText(_ date: Date) -> String {
        let cal = Calendar.current
        if cal.isDateInToday(date) {
            return "Today"
        } else if cal.isDateInTomorrow(date) {
            return "Tomorrow"
        } else {
            return date.dayFormatted
        }
    }
}

struct CalendarPopoverView: View {
    let event: KeyEvent
    let onAddApple: () -> Void
    let onAddGoogle: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            // Preview
            Text(event.title)
                .font(.headline)
                .lineLimit(3)

            if let date = event.date {
                Label(date.chatDateFormatted, systemImage: "clock")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }

            if let location = event.location {
                Label(location, systemImage: "mappin")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }

            if let chatName = event.chat_name {
                Label(chatName, systemImage: "bubble.left")
                    .font(.caption)
                    .foregroundStyle(.tertiary)
            }

            Divider()

            // Actions
            Button(action: onAddApple) {
                HStack(spacing: 6) {
                    Image(systemName: "calendar")
                        .foregroundStyle(.red)
                    Text("Add to Apple Calendar")
                    Spacer()
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            Button(action: onAddGoogle) {
                HStack(spacing: 6) {
                    Image(systemName: "globe")
                        .foregroundStyle(.blue)
                    Text("Add to Google Calendar")
                    Spacer()
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
        }
        .padding(12)
        .frame(width: 260)
    }
}

struct CompletedRowView: View {
    let title: String
    let chatName: String?

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: "checkmark.circle.fill")
                .font(.system(size: 14))
                .foregroundStyle(.green.opacity(0.5))
                .padding(.top, 1)

            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.caption)
                    .lineLimit(2)
                    .strikethrough()
                    .foregroundStyle(.secondary)

                if let chatName {
                    Label(chatName, systemImage: "bubble.left")
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                        .lineLimit(1)
                }
            }

            Spacer(minLength: 0)
        }
        .padding(.vertical, 3)
        .padding(.horizontal, 6)
    }
}

struct RemovedEventRowView: View {
    let title: String
    let chatName: String?

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: "xmark.circle.fill")
                .font(.system(size: 14))
                .foregroundStyle(.secondary.opacity(0.5))
                .padding(.top, 1)

            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.caption)
                    .lineLimit(2)
                    .strikethrough()
                    .foregroundStyle(.secondary)

                if let chatName {
                    Label(chatName, systemImage: "bubble.left")
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                        .lineLimit(1)
                }
            }

            Spacer(minLength: 0)
        }
        .padding(.vertical, 3)
        .padding(.horizontal, 6)
    }
}
