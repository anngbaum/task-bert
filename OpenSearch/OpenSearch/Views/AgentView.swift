import SwiftUI

struct AgentView: View {
    @ObservedObject var viewModel: SearchViewModel

    var body: some View {
        VStack(spacing: 0) {
            // Input bar
            HStack(spacing: 12) {
                HStack {
                    Image(systemName: "sparkles")
                        .foregroundStyle(.purple)

                    TextField("Ask anything about your messages...", text: $viewModel.agentQuery)
                        .textFieldStyle(.plain)
                        .onSubmit {
                            Task { await viewModel.runAgentQuery() }
                        }

                    if !viewModel.agentQuery.isEmpty {
                        Button {
                            viewModel.agentQuery = ""
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

                Button {
                    Task { await viewModel.runAgentQuery() }
                } label: {
                    Image(systemName: "arrow.right.circle.fill")
                        .font(.title2)
                }
                .buttonStyle(.plain)
                .disabled(
                    viewModel.agentQuery.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                    || viewModel.isAgentRunning
                )
                .help("Run agent search")
            }
            .padding(.horizontal)
            .padding(.top, 8)

            Divider()
                .padding(.top, 8)

            // Response area
            if viewModel.isAgentRunning {
                AgentProgressView(steps: viewModel.agentProgress)
            } else if let error = viewModel.agentError {
                VStack(spacing: 12) {
                    Image(systemName: "exclamationmark.triangle")
                        .font(.system(size: 36))
                        .foregroundStyle(.red.opacity(0.6))
                    Text(error)
                        .font(.caption)
                        .foregroundStyle(.red)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, 40)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let response = viewModel.agentResponse {
                AgentResponseView(response: response, viewModel: viewModel, steps: viewModel.agentProgress)
            } else {
                VStack(spacing: 12) {
                    Image(systemName: "sparkles")
                        .font(.system(size: 48))
                        .foregroundStyle(.tertiary)
                    Text("Agentic Search")
                        .font(.title3)
                        .foregroundStyle(.secondary)
                    Text("Ask a question and the AI will search your messages, read context, and synthesize an answer.")
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, 60)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
    }
}

// MARK: - Agent Response View

struct AgentResponseView: View {
    let response: SearchService.AgentResponse
    let viewModel: SearchViewModel
    let steps: [AgentProgressStep]
    @State private var showSteps = false

    /// Ordered, deduplicated list of MSG-IDs as they appear in the answer
    private var referencedLinks: [(index: Int, link: SearchService.AgentMessageLink)] {
        var seen = Set<Int>()
        var result: [(Int, SearchService.AgentMessageLink)] = []
        // Walk the answer to find [[MSG-ID]] in order
        let pattern = #"\[\[MSG-(\d+)\]\]"#
        guard let regex = try? NSRegularExpression(pattern: pattern) else { return [] }
        let nsAnswer = response.answer as NSString
        let matches = regex.matches(in: response.answer, range: NSRange(location: 0, length: nsAnswer.length))
        for match in matches {
            if let idRange = Range(match.range(at: 1), in: response.answer),
               let msgId = Int(response.answer[idRange]),
               !seen.contains(msgId) {
                seen.insert(msgId)
                if let link = response.message_links.first(where: { $0.message_id == msgId }) {
                    result.append((result.count + 1, link))
                }
            }
        }
        return result
    }

    /// Map from message_id → footnote number
    private var footnoteMap: [Int: Int] {
        var map: [Int: Int] = [:]
        for (index, link) in referencedLinks {
            map[link.message_id] = index
        }
        return map
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                // Collapsible progress steps
                if !steps.isEmpty {
                    VStack(alignment: .leading, spacing: 0) {
                        Button {
                            withAnimation(.easeInOut(duration: 0.2)) { showSteps.toggle() }
                        } label: {
                            HStack(spacing: 4) {
                                Image(systemName: "chevron.right")
                                    .font(.system(size: 8, weight: .bold))
                                    .foregroundStyle(.secondary)
                                    .rotationEffect(.degrees(showSteps ? 90 : 0))
                                Image(systemName: "wrench")
                                    .font(.caption2)
                                    .foregroundStyle(.secondary)
                                Text("\(response.tool_calls_count) tool calls")
                                    .font(.caption2)
                                    .foregroundStyle(.secondary)
                                Spacer()
                            }
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)

                        if showSteps {
                            VStack(alignment: .leading, spacing: 2) {
                                ForEach(steps) { step in
                                    AgentStepRow(step: step)
                                }
                            }
                            .padding(.top, 4)
                            .padding(.leading, 12)
                        }
                    }
                    .padding(.horizontal, 16)
                    .padding(.top, 8)
                }

                // Answer text — single Text view, fully selectable, wraps naturally
                AgentAnswerText(answer: response.answer, footnoteMap: footnoteMap)
                    .padding(.horizontal, 16)
                    .padding(.top, steps.isEmpty ? 8 : 0)

                // Import more messages prompt
                if let moreNeeded = response.more_messages_needed {
                    ImportMoreMessagesView(moreNeeded: moreNeeded, viewModel: viewModel)
                        .padding(.horizontal, 16)
                }

                // Referenced messages with footnote numbers
                if !referencedLinks.isEmpty {
                    Divider()
                        .padding(.horizontal, 16)

                    VStack(alignment: .leading, spacing: 4) {
                        Text("Referenced Messages")
                            .font(.caption)
                            .fontWeight(.semibold)
                            .foregroundStyle(.secondary)
                            .padding(.horizontal, 16)

                        ForEach(referencedLinks, id: \.link.message_id) { index, link in
                            MessageLinkRow(link: link, footnote: index) {
                                Task { await viewModel.openThread(for: link.message_id) }
                            }
                        }
                    }
                }
            }
            .padding(.bottom, 16)
        }
    }
}

// MARK: - Answer Text (single Text view — wraps and selects properly)

struct AgentAnswerText: View {
    let answer: String
    let footnoteMap: [Int: Int]  // message_id → footnote number

    var body: some View {
        buildFullText()
            .font(.callout)
            .textSelection(.enabled)
    }

    private func buildFullText() -> Text {
        // Parse the entire answer into segments, then concatenate into one Text
        let segments = parseAll(answer)
        var result = Text("")
        for segment in segments {
            switch segment {
            case .plain(let str):
                result = result + Text(str)
            case .bold(let str):
                result = result + Text(str).bold()
            case .link(let msgId):
                let footnote = footnoteMap[msgId] ?? 0
                result = result + Text("[\(footnote)]")
                    .font(.caption2)
                    .foregroundColor(Color.accentColor)
                    .baselineOffset(4)
            }
        }
        return result
    }

    // MARK: - Parsing

    enum AnswerSegment {
        case plain(String)
        case bold(String)
        case link(Int)
    }

    private func parseAll(_ input: String) -> [AnswerSegment] {
        // Split on [[MSG-ID]] references first
        var segments: [AnswerSegment] = []
        var remaining = input[input.startIndex...]

        while let range = remaining.range(of: #"\[\[MSG-(\d+)\]\]"#, options: .regularExpression) {
            let before = remaining[remaining.startIndex..<range.lowerBound]
            if !before.isEmpty {
                segments.append(contentsOf: parseBold(String(before)))
            }

            let matched = String(remaining[range])
            if let idStr = matched.components(separatedBy: CharacterSet.decimalDigits.inverted).filter({ !$0.isEmpty }).first,
               let msgId = Int(idStr) {
                segments.append(.link(msgId))
            } else {
                segments.append(.plain(matched))
            }

            remaining = remaining[range.upperBound...]
        }

        if !remaining.isEmpty {
            segments.append(contentsOf: parseBold(String(remaining)))
        }

        return segments
    }

    /// Parse **bold** markers within a plain text string
    private func parseBold(_ input: String) -> [AnswerSegment] {
        var segments: [AnswerSegment] = []
        var remaining = input[input.startIndex...]

        while let range = remaining.range(of: #"\*\*(.+?)\*\*"#, options: .regularExpression) {
            let before = remaining[remaining.startIndex..<range.lowerBound]
            if !before.isEmpty {
                segments.append(.plain(String(before)))
            }

            let matched = String(remaining[range])
            let inner = String(matched.dropFirst(2).dropLast(2))
            segments.append(.bold(inner))

            remaining = remaining[range.upperBound...]
        }

        if !remaining.isEmpty {
            segments.append(.plain(String(remaining)))
        }

        return segments
    }
}

// MARK: - Progress View (shown while agent is running)

struct AgentProgressView: View {
    let steps: [AgentProgressStep]

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(steps) { step in
                        AgentStepRow(step: step)
                            .id(step.id)
                    }

                    // Spinner for active step
                    HStack(spacing: 6) {
                        ProgressView()
                            .controlSize(.small)
                        if let last = steps.last {
                            if last.eventType == "tool_call" {
                                Text("Running...")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            } else {
                                Text("Thinking...")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        } else {
                            Text("Starting...")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                    .padding(.top, 4)
                    .id("spinner")
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 16)
                .padding(.vertical, 12)
            }
            .onChange(of: steps.count) { _ in
                withAnimation {
                    proxy.scrollTo("spinner", anchor: .bottom)
                }
            }
        }
    }
}

// MARK: - Step Row

struct AgentStepRow: View {
    let step: AgentProgressStep

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: iconName)
                .font(.system(size: 9))
                .foregroundStyle(iconColor)
                .frame(width: 14)

            Text(step.description)
                .font(.caption)
                .foregroundStyle(step.eventType == "tool_result" ? .secondary : .primary)
        }
        .padding(.vertical, 1)
    }

    private var iconName: String {
        switch step.eventType {
        case "thinking": return "brain"
        case "tool_call": return "arrow.right.circle"
        case "tool_result": return "checkmark.circle"
        default: return "circle"
        }
    }

    private var iconColor: Color {
        switch step.eventType {
        case "thinking": return .purple
        case "tool_call": return .blue
        case "tool_result": return .green
        default: return .secondary
        }
    }
}

// MARK: - Message Link Row

struct MessageLinkRow: View {
    let link: SearchService.AgentMessageLink
    let footnote: Int
    let onTap: () -> Void

    var body: some View {
        Button(action: onTap) {
            HStack(alignment: .top, spacing: 8) {
                Text("[\(footnote)]")
                    .font(.caption2)
                    .fontWeight(.bold)
                    .foregroundStyle(Color.accentColor)
                    .frame(width: 24, alignment: .trailing)
                    .padding(.top, 2)

                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 6) {
                        Text(link.sender)
                            .font(.caption)
                            .fontWeight(.medium)
                        if let chatName = link.chat_name {
                            Text("in \(chatName)")
                                .font(.caption2)
                                .foregroundStyle(.tertiary)
                        }
                        Spacer()
                        if let date = link.date {
                            Text(formatDate(date))
                                .font(.caption2)
                                .foregroundStyle(.tertiary)
                        }
                    }

                    Text(link.text)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }

                Spacer(minLength: 0)
            }
            .padding(.vertical, 4)
            .padding(.horizontal, 16)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .background(Color.primary.opacity(0.02))
    }

    private func formatDate(_ isoString: String) -> String {
        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let date = iso.date(from: isoString) ?? {
            iso.formatOptions = [.withInternetDateTime]
            return iso.date(from: isoString)
        }() else { return isoString }

        let cal = Calendar.current
        if cal.isDateInToday(date) {
            let fmt = DateFormatter()
            fmt.dateFormat = "h:mm a"
            return fmt.string(from: date)
        } else {
            let fmt = DateFormatter()
            fmt.dateFormat = "MMM d"
            return fmt.string(from: date)
        }
    }
}

// MARK: - Import More Messages

struct ImportMoreMessagesView: View {
    let moreNeeded: SearchService.MoreMessagesNeeded
    let viewModel: SearchViewModel
    @State private var isImporting = false
    @State private var importDone = false
    @State private var progressMessage: String = ""
    @State private var errorMessage: String?
    @State private var selectedDate: Date

    init(moreNeeded: SearchService.MoreMessagesNeeded, viewModel: SearchViewModel) {
        self.moreNeeded = moreNeeded
        self.viewModel = viewModel
        // Default to 60 days before the earliest imported message
        let earliest = Self.parseDate(moreNeeded.earliest_message)
        let defaultDate = Calendar.current.date(byAdding: .day, value: -60, to: earliest ?? Date()) ?? Date()
        _selectedDate = State(initialValue: defaultDate)
    }

    private static func parseDate(_ str: String?) -> Date? {
        guard let str else { return nil }
        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return iso.date(from: str) ?? {
            iso.formatOptions = [.withInternetDateTime]
            return iso.date(from: str)
        }()
    }

    private var earliestDate: Date? {
        Self.parseDate(moreNeeded.earliest_message)
    }

    private var formattedEarliest: String {
        guard let date = earliestDate else { return "unknown" }
        let fmt = DateFormatter()
        fmt.dateFormat = "MMMM d, yyyy"
        return fmt.string(from: date)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Image(systemName: "clock.arrow.circlepath")
                    .foregroundStyle(.orange)
                Text("Messages only imported since \(formattedEarliest)")
                    .font(.caption)
                    .fontWeight(.medium)
            }

            Text("The answer may be in older messages. Import more to expand the search.")
                .font(.caption)
                .foregroundStyle(.secondary)

            if importDone {
                HStack(spacing: 4) {
                    Image(systemName: "checkmark.circle.fill")
                        .foregroundStyle(.green)
                    Text("Import complete. Try your search again.")
                        .font(.caption)
                        .foregroundStyle(.green)
                }
            } else if isImporting {
                HStack(spacing: 6) {
                    ProgressView()
                        .controlSize(.small)
                    Text(progressMessage.isEmpty ? "Starting import..." : progressMessage)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            } else if let error = errorMessage {
                Text(error)
                    .font(.caption)
                    .foregroundStyle(.red)
            } else {
                HStack(spacing: 8) {
                    Text("Import from:")
                        .font(.caption)
                    DatePicker("", selection: $selectedDate, in: ...Date(), displayedComponents: .date)
                        .labelsHidden()
                        .controlSize(.small)

                    Button {
                        Task { await importMore() }
                    } label: {
                        HStack(spacing: 4) {
                            Image(systemName: "arrow.down.circle")
                            Text("Import")
                                .font(.caption)
                        }
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                }
            }
        }
        .padding(12)
        .background(Color.orange.opacity(0.08))
        .clipShape(RoundedRectangle(cornerRadius: 8))
    }

    private func importMore() async {
        isImporting = true
        errorMessage = nil
        progressMessage = "Starting import..."

        do {
            let service = SearchService()
            try await service.startImportOlderMessages(since: selectedDate)

            // Poll /health for progress
            while true {
                try await Task.sleep(nanoseconds: 1_500_000_000)
                let health = try await service.fetchHealth()

                if health.syncing, let progress = health.progress {
                    let pct = Int(progress.percent)

                    if progress.stage == "etl" {
                        progressMessage = progress.detail.isEmpty ? "Importing messages... (\(pct)%)" : "\(progress.detail) (\(pct)%)"
                    } else if progress.stage == "embedding" {
                        progressMessage = "Generating embeddings... (\(pct)%)"
                    } else if progress.stage == "done" {
                        break
                    } else {
                        progressMessage = progress.detail.isEmpty ? "Working... (\(pct)%)" : progress.detail
                    }
                } else if !health.syncing {
                    break
                }
            }

            importDone = true
        } catch {
            errorMessage = "Import failed: \(error.localizedDescription)"
        }
        isImporting = false
    }
}
