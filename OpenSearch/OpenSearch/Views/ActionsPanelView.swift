import SwiftUI
import EventKit

struct ActionsPanelView: View {
    @ObservedObject var viewModel: SearchViewModel
    @State private var expandedSections: Set<String> = ["actions", "followups", "events"]

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
            } else if viewModel.keyEvents.isEmpty && viewModel.suggestedFollowUps.isEmpty && viewModel.actionItems.isEmpty && viewModel.completedFollowUps.isEmpty && viewModel.completedActionItems.isEmpty {
                VStack(spacing: 12) {
                    Image(systemName: "checklist")
                        .font(.system(size: 48))
                        .foregroundStyle(.tertiary)
                    Text("No items yet")
                        .font(.title3)
                        .foregroundStyle(.secondary)
                    Text("Events, follow-ups, and action items will appear here after syncing")
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                        .multilineTextAlignment(.center)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ScrollViewReader { proxy in
                    ScrollView {
                        VStack(alignment: .leading, spacing: 12) {
                            // Action Items
                            if !viewModel.actionItems.isEmpty {
                                CollapsibleSection(
                                    title: "Action Items",
                                    icon: "exclamationmark.circle.fill",
                                    color: .orange,
                                    count: viewModel.actionItems.count,
                                    isExpanded: expandedSections.contains("actions"),
                                    onToggle: { toggleSection("actions") }
                                ) {
                                    ForEach(viewModel.actionItems) { item in
                                        CompletableRowView(
                                            title: item.title,
                                            chatName: item.chat_name,
                                            date: item.date,
                                            accentColor: .orange,
                                            onComplete: { await viewModel.completeActionItem(id: item.id) },
                                            onTap: { Task { await viewModel.openThread(for: item.message_id) } }
                                        )
                                    }
                                }
                            }

                            // Suggested Follow-ups
                            if !viewModel.suggestedFollowUps.isEmpty {
                                CollapsibleSection(
                                    title: "Follow-ups",
                                    icon: "arrow.turn.up.right",
                                    color: .blue,
                                    count: viewModel.suggestedFollowUps.count,
                                    isExpanded: expandedSections.contains("followups"),
                                    onToggle: { toggleSection("followups") }
                                ) {
                                    ForEach(viewModel.suggestedFollowUps) { item in
                                        CompletableRowView(
                                            title: item.title,
                                            chatName: item.chat_name,
                                            date: item.date,
                                            accentColor: .blue,
                                            onComplete: { await viewModel.completeFollowUp(id: item.id) },
                                            onTap: item.message_id.map { msgId in
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
                            if viewModel.actionItems.isEmpty && viewModel.suggestedFollowUps.isEmpty && !viewModel.keyEvents.isEmpty {
                                Text("All caught up!")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                    .padding(.vertical, 8)
                            }

                            // Completed toggle
                            let completedCount = viewModel.completedFollowUps.count + viewModel.completedActionItems.count
                            let removedCount = viewModel.removedEvents.count
                            let archivedTotal = completedCount + removedCount
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
                                if completedCount > 0 {
                                    ForEach(viewModel.completedActionItems) { item in
                                        CompletedRowView(title: item.title, chatName: item.chat_name)
                                    }
                                    ForEach(viewModel.completedFollowUps) { item in
                                        CompletedRowView(title: item.title, chatName: item.chat_name)
                                    }
                                }

                                if removedCount > 0 {
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

struct SectionHeader: View {
    let title: String
    let icon: String
    let color: Color

    var body: some View {
        HStack(spacing: 4) {
            Image(systemName: icon)
                .font(.system(size: 10))
                .foregroundStyle(color)
            Text(title)
                .font(.caption)
                .fontWeight(.semibold)
                .foregroundStyle(.secondary)
        }
        .padding(.top, 4)
    }
}

struct CompletableRowView: View {
    let title: String
    let chatName: String?
    let date: Date?
    let accentColor: Color
    let onComplete: () async -> Void
    let onTap: (() -> Void)?
    @State private var markedDone = false

    var body: some View {
        HStack(alignment: .center, spacing: 8) {
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.caption)
                    .lineLimit(2)
                    .strikethrough(markedDone)
                    .opacity(markedDone ? 0.5 : 1)

                HStack(spacing: 8) {
                    if let chatName {
                        Label(chatName, systemImage: "bubble.left")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                    if let date {
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
                }

                if let msg = calendarMessage {
                    Text(msg)
                        .font(.caption2)
                        .foregroundStyle(.green)
                }
            }

            Spacer(minLength: 0)

            if event.date != nil {
                Button {
                    addToCalendar()
                } label: {
                    Image(systemName: "calendar.badge.plus")
                        .font(.system(size: 14))
                        .foregroundStyle(.purple)
                        .frame(width: 28, height: 28)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .help("Add to Calendar")
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

    private func addToCalendar() {
        guard let date = event.date else { return }
        let store = EKEventStore()

        let saveEvent = {
            let calEvent = EKEvent(eventStore: store)
            calEvent.title = event.title
            calEvent.startDate = date
            calEvent.endDate = date.addingTimeInterval(3600)
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
