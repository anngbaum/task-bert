import SwiftUI
import EventKit

struct EventsPanelView: View {
    @ObservedObject var viewModel: SearchViewModel
    @State private var showRemovedEvents = false

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
                    VStack(alignment: .leading, spacing: 8) {
                        ForEach(viewModel.keyEvents) { event in
                            EventCardView(event: event, viewModel: viewModel)
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

// MARK: - Event Card (with Remind Me + Calendar buttons)

struct EventCardView: View {
    let event: KeyEvent
    let viewModel: SearchViewModel
    @State private var isDeleted = false
    @State private var calendarMessage: String?
    @State private var showCalendarPopover = false
    @State private var showRemindForm = false

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            VStack(alignment: .leading, spacing: 4) {
                Text(event.title)
                    .font(.callout)
                    .lineLimit(3)

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
                if let location = event.location {
                    Label(location, systemImage: "mappin")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }

                if let msg = calendarMessage {
                    Text(msg)
                        .font(.caption2)
                        .foregroundStyle(msg.contains("Failed") || msg.contains("denied") ? .red : .green)
                }
            }

            Spacer(minLength: 0)

            // Remind Me button
            Button {
                showRemindForm = true
            } label: {
                Image(systemName: "bell.badge")
                    .font(.system(size: 13))
                    .foregroundStyle(.orange)
                    .frame(width: 28, height: 28)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help("Create a reminder task")

            // Add to Calendar
            if event.date != nil {
                Button {
                    showCalendarPopover = true
                } label: {
                    Image(systemName: "calendar.badge.plus")
                        .font(.system(size: 13))
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

            // Remove
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
                    .font(.system(size: 13))
                    .foregroundStyle(.secondary)
                    .frame(width: 28, height: 28)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help("Remove event")
        }
        .opacity(isDeleted ? 0.3 : 1)
        .padding(.vertical, 6)
        .padding(.horizontal, 10)
        .background(Color.primary.opacity(0.03))
        .cornerRadius(8)
        .contentShape(Rectangle())
        .onTapGesture {
            if let messageId = event.message_id {
                Task { await viewModel.openThread(for: messageId) }
            }
        }
        .sheet(isPresented: $showRemindForm) {
            RemindMeFormView(event: event, viewModel: viewModel)
        }
    }

    // MARK: - Calendar helpers (same as original EventRowView)

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
                        .foregroundStyle(.purple)
                    Text(event.title)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
            }
            .padding(8)
            .background(Color.primary.opacity(0.03))
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
                            chatId: event.chat_id,
                            keyEventId: event.id
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
