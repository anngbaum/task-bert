import SwiftUI

struct SearchBarView: View {
    @ObservedObject var viewModel: SearchViewModel

    private static let dateFormatter: DateFormatter = {
        let f = DateFormatter()
        f.dateStyle = .medium
        f.timeStyle = .none
        return f
    }()

    var body: some View {
        VStack(spacing: 8) {
            // Row 1: search field + search button
            HStack(spacing: 12) {
                searchField
                searchButton
            }
            .zIndex(1)

            // Row 2: filter chips + time controls
            HStack(spacing: 8) {
                // Time preset buttons
                ForEach(TimePreset.allCases) { preset in
                    timePresetButton(preset)
                }
                customTimeButton

                // with: chips
                ForEach(viewModel.filters.withContacts) { contact in
                    chipView(label: "with: \(contact.name)") {
                        viewModel.removeWithContact(contact)
                    }
                }

                // sent_by: chips
                ForEach(viewModel.filters.sentByContacts) { contact in
                    chipView(label: "sent_by: \(contact.name)") {
                        viewModel.removeSentByContact(contact)
                    }
                }
                if viewModel.filters.sentByMe {
                    chipView(label: "sent_by: me") {
                        viewModel.filters.sentByMe = false
                    }
                }

                // in: chip
                if let group = viewModel.filters.groupChat {
                    chipView(label: "in: \(group.name)") {
                        viewModel.filters.groupChat = nil
                    }
                }

                Spacer()
            }

            // Row 3: date pickers (shown when dates are set)
            if viewModel.filters.effectiveAfterDate != nil || viewModel.filters.effectiveBeforeDate != nil {
                HStack(spacing: 12) {
                    HStack(spacing: 4) {
                        Text("From:").font(.caption).foregroundStyle(.secondary)
                        DatePicker("", selection: Binding(
                            get: { viewModel.filters.afterDate ?? viewModel.filters.effectiveAfterDate ?? Date() },
                            set: { newDate in
                                viewModel.filters.afterDate = newDate
                                viewModel.filters.timePreset = matchingPreset()
                            }
                        ), displayedComponents: .date)
                        .labelsHidden()
                        .controlSize(.small)
                    }

                    HStack(spacing: 4) {
                        Text("To:").font(.caption).foregroundStyle(.secondary)
                        DatePicker("", selection: Binding(
                            get: { viewModel.filters.beforeDate ?? viewModel.filters.effectiveBeforeDate ?? Date() },
                            set: { newDate in
                                viewModel.filters.beforeDate = newDate
                                viewModel.filters.timePreset = matchingPreset()
                            }
                        ), displayedComponents: .date)
                        .labelsHidden()
                        .controlSize(.small)
                    }

                    Button {
                        viewModel.filters.clearDates()
                    } label: {
                        Image(systemName: "xmark.circle.fill")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    .buttonStyle(.plain)
                    .help("Clear date filter")

                    Spacer()
                }
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: .escapeKeyPressed)) { _ in
            if viewModel.showTypeahead {
                viewModel.dismissTypeahead()
            }
        }
        .background(EscapeKeyMonitor())
    }

    /// Check if the current custom dates still match a preset
    private func matchingPreset() -> TimePreset? {
        guard let after = viewModel.filters.afterDate,
              let before = viewModel.filters.beforeDate else { return nil }
        let cal = Calendar.current
        for preset in TimePreset.allCases {
            let range = preset.dateRange
            if cal.isDate(after, inSameDayAs: range.after) && cal.isDate(before, inSameDayAs: range.before) {
                return preset
            }
        }
        return nil
    }

    // MARK: - Subviews

    private var searchField: some View {
        HStack {
            Image(systemName: "magnifyingglass")
                .foregroundStyle(.secondary)

            TextField("Search… (with: sent_by: in:)", text: $viewModel.query)
                .textFieldStyle(.plain)
                .onSubmit {
                    viewModel.dismissTypeahead()
                    Task { await viewModel.search() }
                }
                .onChange(of: viewModel.query) { _ in
                    viewModel.updateTypeahead()
                }

            if !viewModel.query.isEmpty || viewModel.filters.isActive {
                Button {
                    viewModel.clearAll()
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .foregroundStyle(.secondary)
                }
                .buttonStyle(.plain)
            }
        }
        .padding(8)
        .background(.quaternary)
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .overlay(alignment: .topLeading) {
            if viewModel.showTypeahead {
                typeaheadDropdown
                    .offset(y: 38)
            }
        }
    }

    private var typeaheadDropdown: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(viewModel.typeaheadSuggestions) { suggestion in
                Button {
                    viewModel.selectTypeaheadSuggestion(suggestion)
                } label: {
                    HStack(spacing: 8) {
                        Image(systemName: suggestion.icon)
                            .foregroundStyle(.secondary)
                            .frame(width: 16)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(suggestion.title)
                                .font(.body)
                            if let subtitle = suggestion.subtitle {
                                Text(subtitle)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 5)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .background(Color.primary.opacity(0.05))
            }
        }
        .frame(width: 260)
        .background(Color(nsColor: .windowBackgroundColor))
        .cornerRadius(6)
        .shadow(color: .black.opacity(0.15), radius: 4, y: 2)
        .overlay(
            RoundedRectangle(cornerRadius: 6)
                .stroke(Color.primary.opacity(0.1), lineWidth: 1)
        )
    }

    private func chipView(label: String, onRemove: @escaping () -> Void) -> some View {
        HStack(spacing: 3) {
            Text(label)
                .font(.caption)
                .lineLimit(1)
            Button(action: onRemove) {
                Image(systemName: "xmark.circle.fill")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
            .buttonStyle(.plain)
        }
        .padding(.horizontal, 6)
        .padding(.vertical, 3)
        .background(Color.accentColor.opacity(0.15))
        .clipShape(Capsule())
    }

    private func timePresetButton(_ preset: TimePreset) -> some View {
        Button {
            if viewModel.filters.timePreset == preset && !viewModel.filters.isCustomDateRange {
                viewModel.filters.clearDates()
            } else {
                viewModel.filters.applyPreset(preset)
            }
        } label: {
            Text(preset.rawValue)
                .font(.caption)
                .padding(.horizontal, 8)
                .padding(.vertical, 4)
                .background(viewModel.filters.timePreset == preset ? Color.accentColor.opacity(0.2) : Color.primary.opacity(0.05))
                .foregroundStyle(viewModel.filters.timePreset == preset ? Color.accentColor : .primary)
                .clipShape(Capsule())
        }
        .buttonStyle(.plain)
    }

    private var customTimeButton: some View {
        Button {
            if viewModel.filters.isCustomDateRange && viewModel.filters.timePreset == nil {
                viewModel.filters.clearDates()
            } else {
                // Set to custom: clear preset, keep current dates or set defaults
                let after = viewModel.filters.effectiveAfterDate ?? Calendar.current.date(byAdding: .month, value: -1, to: Date())!
                let before = viewModel.filters.effectiveBeforeDate ?? Date()
                viewModel.filters.timePreset = nil
                viewModel.filters.afterDate = after
                viewModel.filters.beforeDate = before
            }
        } label: {
            Text("Custom")
                .font(.caption)
                .padding(.horizontal, 8)
                .padding(.vertical, 4)
                .background(viewModel.filters.isCustomDateRange && viewModel.filters.timePreset == nil ? Color.accentColor.opacity(0.2) : Color.primary.opacity(0.05))
                .foregroundStyle(viewModel.filters.isCustomDateRange && viewModel.filters.timePreset == nil ? Color.accentColor : .primary)
                .clipShape(Capsule())
        }
        .buttonStyle(.plain)
    }

    private var searchButton: some View {
        Button {
            Task { await viewModel.search() }
        } label: {
            Image(systemName: "arrow.right.circle.fill")
                .font(.title2)
        }
        .buttonStyle(.plain)
        .disabled(viewModel.query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || viewModel.isSearching)
        .help("Search")
    }
}

// MARK: - Escape key handling (macOS 13 compatible)

extension Notification.Name {
    static let escapeKeyPressed = Notification.Name("escapeKeyPressed")
}

struct EscapeKeyMonitor: NSViewRepresentable {
    func makeNSView(context: Context) -> NSView {
        let view = NSView()
        context.coordinator.monitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { event in
            if event.keyCode == 53 { // Escape key
                NotificationCenter.default.post(name: .escapeKeyPressed, object: nil)
            }
            return event
        }
        return view
    }

    func updateNSView(_ nsView: NSView, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator() }

    class Coordinator {
        var monitor: Any?
        deinit {
            if let monitor { NSEvent.removeMonitor(monitor) }
        }
    }
}
