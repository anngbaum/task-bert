import SwiftUI

struct SearchBarView: View {
    @ObservedObject var viewModel: SearchViewModel
    @State private var selectedTypeaheadIndex: Int = -1
    @State private var showImportMore: Bool = false

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
                allTimeButton

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
                        .datePickerStyle(.field)
                        .labelsHidden()
                        .frame(minWidth: 110)
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
                        .datePickerStyle(.field)
                        .labelsHidden()
                        .frame(minWidth: 110)
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

            // Import more section
            if let earliest = viewModel.dataRangeEarliest, let days = viewModel.dataRangeDaysCovered {
                HStack(spacing: 0) {
                    Button {
                        withAnimation(.easeInOut(duration: 0.2)) { showImportMore.toggle() }
                    } label: {
                        HStack(spacing: 4) {
                            Image(systemName: "chevron.right")
                                .font(.system(size: 8))
                                .rotationEffect(.degrees(showImportMore ? 90 : 0))
                            Text("Import More")
                                .font(.caption2)
                        }
                        .foregroundStyle(.secondary)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    Spacer()
                }

                if showImportMore {
                    DataRangeBannerView(earliest: earliest, daysCovered: days, noResults: false)
                }
            }
        }
        .onChange(of: viewModel.showTypeahead) { visible in
            EscapeKeyMonitor.typeaheadVisible = visible
        }
        .onReceive(NotificationCenter.default.publisher(for: .escapeKeyPressed)) { _ in
            if viewModel.showTypeahead {
                viewModel.dismissTypeahead()
                selectedTypeaheadIndex = -1
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: .arrowDownPressed)) { _ in
            guard viewModel.showTypeahead, !viewModel.typeaheadSuggestions.isEmpty else { return }
            selectedTypeaheadIndex = min(selectedTypeaheadIndex + 1, viewModel.typeaheadSuggestions.count - 1)
        }
        .onReceive(NotificationCenter.default.publisher(for: .arrowUpPressed)) { _ in
            guard viewModel.showTypeahead, !viewModel.typeaheadSuggestions.isEmpty else { return }
            selectedTypeaheadIndex = max(selectedTypeaheadIndex - 1, 0)
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
                    if viewModel.showTypeahead && selectedTypeaheadIndex >= 0 && selectedTypeaheadIndex < viewModel.typeaheadSuggestions.count {
                        viewModel.selectTypeaheadSuggestion(viewModel.typeaheadSuggestions[selectedTypeaheadIndex])
                        selectedTypeaheadIndex = -1
                    } else {
                        viewModel.dismissTypeahead()
                        Task { await viewModel.search() }
                    }
                }
                .onChange(of: viewModel.query) { _ in
                    viewModel.updateTypeahead()
                    selectedTypeaheadIndex = -1
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
            ForEach(Array(viewModel.typeaheadSuggestions.enumerated()), id: \.element.id) { index, suggestion in
                Button {
                    viewModel.selectTypeaheadSuggestion(suggestion)
                    selectedTypeaheadIndex = -1
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
                .background(index == selectedTypeaheadIndex ? AppColors.filterChip : AppColors.buttonBackground)
            }
        }
        .frame(width: 260)
        .background(Color(nsColor: .windowBackgroundColor))
        .cornerRadius(6)
        .shadow(color: AppColors.dropShadow, radius: 4, y: 2)
        .overlay(
            RoundedRectangle(cornerRadius: 6)
                .stroke(AppColors.dividerStroke, lineWidth: 1)
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
        .background(AppColors.filterChip)
        .clipShape(Capsule())
    }

    private var isAllTime: Bool {
        viewModel.filters.timePreset == nil && !viewModel.filters.isCustomDateRange
    }

    private var allTimeButton: some View {
        let daysLabel = viewModel.dataRangeDaysCovered.map { " (\($0)d)" } ?? ""
        return Button {
            viewModel.filters.clearDates()
        } label: {
            Text("All Time\(daysLabel)")
                .font(.caption)
                .padding(.horizontal, 8)
                .padding(.vertical, 4)
                .background(isAllTime ? AppColors.filterSelected : AppColors.buttonBackground)
                .foregroundStyle(isAllTime ? Color.accentColor : .primary)
                .clipShape(Capsule())
        }
        .buttonStyle(.plain)
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
                .background(viewModel.filters.timePreset == preset ? AppColors.filterSelected : AppColors.buttonBackground)
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
                .background(viewModel.filters.isCustomDateRange && viewModel.filters.timePreset == nil ? AppColors.filterSelected : AppColors.buttonBackground)
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
    static let arrowDownPressed = Notification.Name("arrowDownPressed")
    static let arrowUpPressed = Notification.Name("arrowUpPressed")
}

struct EscapeKeyMonitor: NSViewRepresentable {
    static var typeaheadVisible = false

    func makeNSView(context: Context) -> NSView {
        let view = NSView()
        context.coordinator.monitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { event in
            switch event.keyCode {
            case 53: // Escape
                NotificationCenter.default.post(name: .escapeKeyPressed, object: nil)
            case 125: // Down arrow
                if Self.typeaheadVisible {
                    NotificationCenter.default.post(name: .arrowDownPressed, object: nil)
                    return nil // consume so cursor doesn't move in text field
                }
            case 126: // Up arrow
                if Self.typeaheadVisible {
                    NotificationCenter.default.post(name: .arrowUpPressed, object: nil)
                    return nil
                }
            default:
                break
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
