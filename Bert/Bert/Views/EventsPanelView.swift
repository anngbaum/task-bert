import SwiftUI
import EventKit

struct EventsPanelView: View {
    @ObservedObject var viewModel: SearchViewModel
    @State private var showPastEvents = false
    @State private var showRemovedEvents = false

    private var futureEvents: [KeyEvent] {
        let startOfToday = Calendar.current.startOfDay(for: Date())
        return viewModel.keyEvents
            .filter { event in
                guard let date = event.date else { return false }
                return date >= startOfToday
            }
            .sorted { $0.date! < $1.date! }
    }

    private var undatedEvents: [KeyEvent] {
        viewModel.keyEvents.filter { $0.date == nil }
    }

    private var pastEvents: [KeyEvent] {
        let startOfToday = Calendar.current.startOfDay(for: Date())
        return viewModel.keyEvents
            .filter { event in
                guard let date = event.date else { return false }
                return date < startOfToday
            }
            .sorted { ($0.date ?? .distantPast) > ($1.date ?? .distantPast) }
    }

    /// Group events by calendar day
    private func groupByDay(_ events: [KeyEvent]) -> [(label: String, events: [KeyEvent])] {
        let cal = Calendar.current
        var groups: [(key: Date?, label: String, events: [KeyEvent])] = []

        for event in events {
            let dayStart = event.date.map { cal.startOfDay(for: $0) }
            let label = dayLabel(for: event.date)

            if groups.isEmpty || dayStart != groups.last!.key {
                groups.append((key: dayStart, label: label, events: [event]))
            } else {
                groups[groups.count - 1].events.append(event)
            }
        }

        return groups.map { (label: $0.label, events: $0.events) }
    }

    private func dayLabel(for date: Date?) -> String {
        guard let date else { return "No Date" }
        let cal = Calendar.current
        if cal.isDateInToday(date) {
            return "Today"
        } else if cal.isDateInTomorrow(date) {
            return "Tomorrow"
        } else if cal.isDateInYesterday(date) {
            return "Yesterday"
        } else {
            let fmt = DateFormatter()
            fmt.dateFormat = "EEEE MMM d"  // "Sunday Apr 5"
            return fmt.string(from: date)
        }
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
            } else if viewModel.keyEvents.isEmpty && viewModel.removedEvents.isEmpty {
                VStack(spacing: 12) {
                    Image(systemName: "calendar.badge.clock")
                        .font(.system(size: 48))
                        .foregroundStyle(.tertiary)
                    Text("No events yet")
                        .font(.title3)
                        .foregroundStyle(.secondary)
                    Text("Key events from your conversations will appear here after syncing")
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                        .multilineTextAlignment(.center)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ScrollView {
                    VStack(alignment: .leading, spacing: 16) {
                        ForEach(groupByDay(futureEvents), id: \.label) { group in
                            VStack(alignment: .leading, spacing: 4) {
                                Text(group.label)
                                    .font(.caption)
                                    .fontWeight(.semibold)
                                    .foregroundStyle(.secondary)
                                    .padding(.leading, 2)

                                ForEach(group.events) { event in
                                    EventRowView(event: event, viewModel: viewModel)
                                }
                            }
                        }

                        // Upcoming (no specific date)
                        if !undatedEvents.isEmpty {
                            VStack(alignment: .leading, spacing: 4) {
                                Text("Upcoming")
                                    .font(.caption)
                                    .fontWeight(.semibold)
                                    .foregroundStyle(.secondary)
                                    .padding(.leading, 2)

                                ForEach(undatedEvents) { event in
                                    EventRowView(event: event, viewModel: viewModel)
                                }
                            }
                        }

                        // Past
                        if !pastEvents.isEmpty {
                            CollapsibleSection(
                                title: "Past",
                                icon: "clock.arrow.circlepath",
                                color: .secondary,
                                count: pastEvents.count,
                                isExpanded: showPastEvents,
                                onToggle: {
                                    withAnimation(.easeInOut(duration: 0.2)) {
                                        showPastEvents.toggle()
                                    }
                                }
                            ) {
                                ForEach(groupByDay(pastEvents), id: \.label) { group in
                                    VStack(alignment: .leading, spacing: 4) {
                                        Text(group.label)
                                            .font(.caption)
                                            .fontWeight(.semibold)
                                            .foregroundStyle(.secondary)
                                            .padding(.leading, 2)

                                        ForEach(group.events) { event in
                                            EventRowView(event: event, viewModel: viewModel)
                                        }
                                    }
                                }
                            }
                        }

                        // Removed events toggle
                        if !viewModel.removedEvents.isEmpty || showRemovedEvents {
                            Button {
                                withAnimation(.easeInOut(duration: 0.2)) {
                                    showRemovedEvents.toggle()
                                }
                            } label: {
                                HStack(spacing: 4) {
                                    Image(systemName: "chevron.right")
                                        .font(.system(size: 8))
                                        .rotationEffect(.degrees(showRemovedEvents ? 90 : 0))
                                    Text("Removed (\(viewModel.removedEvents.count))")
                                        .font(.caption2)
                                    Spacer()
                                }
                                .foregroundStyle(.secondary)
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            .padding(.top, 4)

                            if showRemovedEvents {
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
        .onAppear {
            Task {
                await viewModel.loadActions()
                await viewModel.loadCompletedActions()
            }
        }
    }
}

// MARK: - Remind Me Form

struct RemindMeFormView: View {
    let event: KeyEvent
    let viewModel: SearchViewModel
    @Environment(\.dismiss) private var dismiss

    @State private var title: String = ""
    @State private var hasDate: Bool = false
    @State private var date: Date = Date()
    @State private var priority: String = "low"
    @State private var isSaving = false

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Create Reminder")
                .font(.headline)

            VStack(alignment: .leading, spacing: 4) {
                Text("Title")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                TextField("Reminder title", text: $title)
                    .textFieldStyle(.roundedBorder)
            }

            VStack(alignment: .leading, spacing: 4) {
                Toggle("Due date", isOn: $hasDate)
                    .toggleStyle(.switch)

                if hasDate {
                    DatePicker("", selection: $date, displayedComponents: [.date, .hourAndMinute])
                        .labelsHidden()
                }
            }

            VStack(alignment: .leading, spacing: 4) {
                Text("Priority")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                Picker("", selection: $priority) {
                    Text("Low").tag("low")
                    Text("High").tag("high")
                }
                .pickerStyle(.segmented)
            }

            // Preview of the source event
            VStack(alignment: .leading, spacing: 2) {
                Text("From event")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
                HStack(spacing: 4) {
                    Image(systemName: "calendar.badge.clock")
                        .font(.caption2)
                        .foregroundStyle(AppColors.eventAccent)
                    Text(event.title)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
            }
            .padding(8)
            .background(AppColors.cardBackground)
            .cornerRadius(6)

            Spacer()

            HStack {
                Spacer()
                Button("Cancel") {
                    dismiss()
                }
                .keyboardShortcut(.cancelAction)

                Button("Create") {
                    isSaving = true
                    Task {
                        await viewModel.createTask(
                            title: title,
                            date: hasDate ? date : nil,
                            priority: priority,
                            chatId: event.chat_id
                        )
                        dismiss()
                    }
                }
                .disabled(title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || isSaving)
                .keyboardShortcut(.defaultAction)
            }
        }
        .padding(20)
        .frame(width: 380, height: 400)
        .onAppear {
            title = "REMINDER: \(event.title)"

            if let eventDate = event.date {
                hasDate = true
                // Default to one day earlier
                date = Calendar.current.date(byAdding: .day, value: -1, to: eventDate) ?? eventDate
            }
        }
    }
}
