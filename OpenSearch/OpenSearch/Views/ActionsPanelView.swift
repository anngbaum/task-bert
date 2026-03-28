import SwiftUI
import EventKit

struct ActionsPanelView: View {
    @ObservedObject var viewModel: SearchViewModel
    @State private var expandedSections: Set<String> = ["high", "low", "events"]

    private var highPriorityTasks: [TaskItem] {
        viewModel.tasks.filter { $0.isHighPriority }
    }

    private var lowPriorityTasks: [TaskItem] {
        viewModel.tasks.filter { !$0.isHighPriority }
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
            } else if viewModel.keyEvents.isEmpty && viewModel.tasks.isEmpty && viewModel.completedTasks.isEmpty && viewModel.removedEvents.isEmpty {
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
                            // High Priority Tasks
                            if !highPriorityTasks.isEmpty {
                                CollapsibleSection(
                                    title: "High Priority",
                                    icon: "exclamationmark.circle.fill",
                                    color: .orange,
                                    count: highPriorityTasks.count,
                                    isExpanded: expandedSections.contains("high"),
                                    onToggle: { toggleSection("high") }
                                ) {
                                    ForEach(highPriorityTasks) { task in
                                        TaskRowView(
                                            task: task,
                                            accentColor: .orange,
                                            onComplete: { await viewModel.completeTask(id: task.id) },
                                            onTap: task.message_id.map { msgId in
                                                { Task { await viewModel.openThread(for: msgId) } }
                                            }
                                        )
                                    }
                                }
                            }

                            // Low Priority Tasks
                            if !lowPriorityTasks.isEmpty {
                                CollapsibleSection(
                                    title: "Low Priority",
                                    icon: "arrow.turn.up.right",
                                    color: .blue,
                                    count: lowPriorityTasks.count,
                                    isExpanded: expandedSections.contains("low"),
                                    onToggle: { toggleSection("low") }
                                ) {
                                    ForEach(lowPriorityTasks) { task in
                                        TaskRowView(
                                            task: task,
                                            accentColor: .blue,
                                            onComplete: { await viewModel.completeTask(id: task.id) },
                                            onTap: task.message_id.map { msgId in
                                                { Task { await viewModel.openThread(for: msgId) } }
                                            }
                                        )
                                    }
                                }
                            }

                            // Key Events
                            if !viewModel.keyEvents.isEmpty {
                                CollapsibleSection(
                                    title: "Key Events",
                                    icon: "calendar.badge.clock",
                                    color: .purple,
                                    count: viewModel.keyEvents.count,
                                    isExpanded: expandedSections.contains("events"),
                                    onToggle: { toggleSection("events") }
                                ) {
                                    ForEach(viewModel.keyEvents) { event in
                                        EventRowView(event: event, viewModel: viewModel)
                                    }
                                }
                            }

                            // All caught up
                            if viewModel.tasks.isEmpty && !viewModel.keyEvents.isEmpty {
                                Text("All caught up!")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                    .padding(.vertical, 8)
                            }

                            // Completed & Removed toggle
                            let archivedTotal = viewModel.completedTasks.count + viewModel.removedEvents.count
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
                                        Text("Completed & Removed (\(archivedTotal))")
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

                                if !viewModel.removedEvents.isEmpty {
                                    HStack(spacing: 4) {
                                        Image(systemName: "trash")
                                            .font(.system(size: 9))
                                            .foregroundStyle(.secondary)
                                        Text("Removed Events")
                                            .font(.caption2)
                                            .foregroundStyle(.secondary)
                                    }
                                    .padding(.top, 6)

                                    ForEach(viewModel.removedEvents) { event in
                                        RemovedEventRowView(title: event.title, chatName: event.chat_name)
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
    @State private var markedDone = false

    var body: some View {
        HStack(alignment: .center, spacing: 8) {
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
                    .foregroundStyle(markedDone ? .green : accentColor)
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
