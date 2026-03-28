import Foundation
import Combine

struct TypeaheadSuggestion: Identifiable {
    enum Kind { case withContact, sentBy, group }
    let id: String
    let title: String
    let subtitle: String?
    let icon: String
    let kind: Kind
    let contact: Contact?
    let group: GroupChat?
}

final class SearchViewModel: ObservableObject {
    @Published var query: String = ""
    @Published var mode: SearchMode = .hybrid
    @Published var filters = SearchFilters()

    @Published private(set) var results: [SearchResult] = []
    @Published private(set) var isSearching: Bool = false
    @Published private(set) var isLoadingMore: Bool = false
    @Published private(set) var hasMore: Bool = false
    @Published private(set) var errorMessage: String? = nil
    @Published private(set) var hasSearched: Bool = false

    // Contacts & groups for typeahead
    @Published private(set) var contacts: [Contact] = []
    @Published private(set) var groups: [GroupChat] = []

    // Typeahead state
    @Published private(set) var showTypeahead: Bool = false
    @Published private(set) var typeaheadSuggestions: [TypeaheadSuggestion] = []
    @Published private(set) var activeKeyword: String? = nil

    // Sync state
    @Published private(set) var isSyncing: Bool = false
    @Published private(set) var lastSyncMessage: String? = nil
    @Published private(set) var lastSyncedAt: Date? = nil

    var syncTooltip: String {
        if isSyncing { return "Syncing..." }
        if let date = lastSyncedAt {
            let formatter = RelativeDateTimeFormatter()
            formatter.unitsStyle = .abbreviated
            let relative = formatter.localizedString(for: date, relativeTo: Date())
            if let msg = lastSyncMessage {
                return "\(msg)\nLast synced: \(relative)"
            }
            return "Last synced: \(relative)"
        }
        return lastSyncMessage ?? "Sync new messages"
    }

    // Chat metadata panel
    @Published private(set) var chatMetadata: [ChatMetadata] = []
    @Published private(set) var isLoadingMetadata: Bool = false
    @Published var showMetadataPanel: Bool = false

    // Actions panel
    @Published private(set) var keyEvents: [KeyEvent] = []
    @Published private(set) var tasks: [TaskItem] = []
    @Published private(set) var completedTasks: [TaskItem] = []
    @Published private(set) var removedEvents: [KeyEvent] = []
    @Published private(set) var isLoadingActions: Bool = false
    @Published var showActionsPanel: Bool = false
    @Published var showCompletedActions: Bool = false

    // Context messages keyed by result message ID
    @Published private(set) var contextMessages: [Int: [ContextMessage]] = [:]
    @Published private(set) var loadingContext: Set<Int> = []
    @Published var expandedResults: Set<Int> = []

    // Thread view state
    @Published private(set) var threadResponse: ThreadResponse? = nil
    @Published private(set) var isLoadingThread: Bool = false
    @Published private(set) var isLoadingMoreThread: Bool = false
    @Published private(set) var threadError: String? = nil
    @Published var threadAnchorId: Int? = nil

    // API key state — controls whether LLM-powered tabs are available
    @Published var hasApiKey: Bool = false

    // Set to true after a hard reset completes — ContentView observes this to reset onboarding
    @Published var didCompleteHardReset: Bool = false

    private let service = SearchService()
    private var healthPollTask: Task<Void, Never>?

    init() {
        // Apply default preset dates
        filters.applyPreset(.pastMonth)
        Task {
            await loadContacts()
            await loadGroups()
            await checkApiKeyStatus()
            await pollServerSyncStatus()
        }
    }

    @MainActor
    func checkApiKeyStatus() async {
        do {
            let settings = try await service.fetchSettings()
            hasApiKey = (settings.anthropicApiKey != nil || settings.openaiApiKey != nil)
        } catch {
            hasApiKey = false
        }
    }

    /// Poll the server's health endpoint on startup to detect background syncs.
    /// Stops polling once the server reports it's no longer syncing.
    @MainActor
    private func pollServerSyncStatus() async {
        // Don't poll if the user already triggered a sync from the UI
        guard !isSyncing else { return }

        do {
            let health = try await service.fetchHealth()
            if health.syncing {
                isSyncing = true
                lastSyncMessage = progressMessage(health.progress)

                // Poll until done
                while true {
                    try await Task.sleep(nanoseconds: 2_000_000_000)
                    let h = try await service.fetchHealth()
                    if !h.syncing && h.ready {
                        break
                    }
                    lastSyncMessage = progressMessage(h.progress)
                }

                // Reload data now that sync is complete
                await loadContacts()
                await loadGroups()
                await loadChatMetadata()
                await loadActions()
                lastSyncMessage = nil
                isSyncing = false
            }
        } catch {
            // Server not reachable yet — ignore
        }
    }

    private func progressMessage(_ progress: SearchService.HealthProgress?) -> String {
        guard let p = progress else {
            return "Sync in progress..."
        }
        switch p.stage {
        case "etl":
            return "Importing messages... (\(Int(p.percent))%)"
        case "embedding":
            return "Generating embeddings... (\(Int(p.percent))%)"
        case "metadata":
            return p.detail.isEmpty ? "Updating conversations... (\(Int(p.percent))%)" : p.detail
        case "setup":
            return "Preparing database..."
        default:
            return p.detail.isEmpty ? "Sync in progress... (\(Int(p.percent))%)" : p.detail
        }
    }

    // MARK: - Typeahead

    private let keywords = ["with:", "sent_by:", "in:"]

    func updateTypeahead() {
        // Check keywords in order of specificity (longest first)
        if let sentByQuery = extractKeyword("sent_by:") {
            activeKeyword = "sent_by:"
            buildContactSuggestions(query: sentByQuery, kind: .sentBy, includeMeOption: true)
        } else if let withQuery = extractKeyword("with:") {
            activeKeyword = "with:"
            buildContactSuggestions(query: withQuery, kind: .withContact, includeMeOption: false)
        } else if let inQuery = extractKeyword("in:") {
            activeKeyword = "in:"
            buildGroupSuggestions(query: inQuery)
        } else {
            dismissTypeahead()
        }
    }

    private func buildContactSuggestions(query searchText: String, kind: TypeaheadSuggestion.Kind, includeMeOption: Bool) {
        var suggestions: [TypeaheadSuggestion] = []

        if includeMeOption && !filters.sentByMe && (searchText.isEmpty || "me".localizedCaseInsensitiveContains(searchText)) {
            suggestions.append(TypeaheadSuggestion(
                id: "sent-by-me",
                title: "me",
                subtitle: "Messages I sent",
                icon: "person.fill",
                kind: .sentBy,
                contact: nil,
                group: nil
            ))
        }

        let alreadySelected: Set<String>
        switch kind {
        case .withContact:
            alreadySelected = Set(filters.withContacts.map(\.id))
        case .sentBy:
            alreadySelected = Set(filters.sentByContacts.map(\.id))
        default:
            alreadySelected = []
        }

        suggestions += contacts
            .filter {
                !alreadySelected.contains($0.id) &&
                (searchText.isEmpty ||
                 $0.name.localizedCaseInsensitiveContains(searchText) ||
                 $0.identifiers.contains(where: { $0.localizedCaseInsensitiveContains(searchText) }))
            }
            .prefix(6)
            .map { contact in
                let subtitle = contact.identifiers.first(where: { $0 != contact.name }) ?? contact.identifiers.first
                return TypeaheadSuggestion(
                    id: "\(kind)-\(contact.id)",
                    title: contact.name,
                    subtitle: subtitle,
                    icon: "person",
                    kind: kind,
                    contact: contact,
                    group: nil
                )
            }

        typeaheadSuggestions = Array(suggestions.prefix(6))
        showTypeahead = !typeaheadSuggestions.isEmpty
    }

    private func buildGroupSuggestions(query searchText: String) {
        typeaheadSuggestions = groups
            .filter {
                searchText.isEmpty || $0.name.localizedCaseInsensitiveContains(searchText)
            }
            .prefix(6)
            .map { group in
                TypeaheadSuggestion(
                    id: "group-\(group.id)",
                    title: group.name,
                    subtitle: nil,
                    icon: "bubble.left.and.bubble.right",
                    kind: .group,
                    contact: nil,
                    group: group
                )
            }
        showTypeahead = !typeaheadSuggestions.isEmpty
    }

    private func extractKeyword(_ keyword: String) -> String? {
        let lower = query.lowercased()
        guard let range = lower.range(of: keyword, options: .backwards) else { return nil }
        if range.lowerBound != lower.startIndex {
            let charBefore = lower[lower.index(before: range.lowerBound)]
            if !charBefore.isWhitespace { return nil }
        }
        let afterKeyword = String(query[range.upperBound...])
        let afterLower = afterKeyword.lowercased()
        // Make sure no other keyword appears after this one
        for kw in keywords where kw != keyword {
            if afterLower.contains(kw) { return nil }
        }
        return afterKeyword
    }

    func selectTypeaheadSuggestion(_ suggestion: TypeaheadSuggestion) {
        // Remove the keyword portion from the query
        if let keyword = activeKeyword,
           let range = query.lowercased().range(of: keyword, options: .backwards) {
            query = String(query[query.startIndex..<range.lowerBound]).trimmingCharacters(in: .whitespaces)
        }

        switch suggestion.kind {
        case .withContact:
            if let contact = suggestion.contact {
                addWithContact(contact)
            }
        case .sentBy:
            if let contact = suggestion.contact {
                addSentByContact(contact)
            } else if suggestion.id == "sent-by-me" {
                filters.sentByMe = true
            }
        case .group:
            if let group = suggestion.group {
                filters.groupChat = group
            }
        }

        dismissTypeahead()
    }

    func dismissTypeahead() {
        showTypeahead = false
        typeaheadSuggestions = []
        activeKeyword = nil
    }

    // MARK: - Contact management

    func addWithContact(_ contact: Contact) {
        if !filters.withContacts.contains(contact) {
            filters.withContacts.append(contact)
        }
    }

    func removeWithContact(_ contact: Contact) {
        filters.withContacts.removeAll { $0.id == contact.id }
    }

    func addSentByContact(_ contact: Contact) {
        if !filters.sentByContacts.contains(contact) {
            filters.sentByContacts.append(contact)
        }
    }

    func removeSentByContact(_ contact: Contact) {
        filters.sentByContacts.removeAll { $0.id == contact.id }
    }

    // MARK: - Search

    private let pageSize = 20

    @MainActor
    func search() async {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }

        isSearching = true
        errorMessage = nil
        hasSearched = true
        hasMore = false
        expandedResults.removeAll()
        contextMessages.removeAll()

        do {
            let response = try await service.search(
                query: trimmed,
                mode: mode,
                filters: filters,
                limit: pageSize,
                offset: 0
            )
            results = response.results
            hasMore = response.hasMore
        } catch is URLError {
            results = []
            errorMessage = "Cannot connect to server. Make sure `npm run serve` is running."
        } catch {
            results = []
            errorMessage = error.localizedDescription
        }

        isSearching = false
    }

    @MainActor
    func loadMore() async {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, hasMore, !isLoadingMore else { return }

        isLoadingMore = true

        do {
            let response = try await service.search(
                query: trimmed,
                mode: mode,
                filters: filters,
                limit: pageSize,
                offset: results.count
            )
            results += response.results
            hasMore = response.hasMore
        } catch {
            // Silently fail — user can retry
        }

        isLoadingMore = false
    }

    func clearAll() {
        query = ""
        filters.reset()
        dismissTypeahead()
    }

    // MARK: - Data loading

    @MainActor
    func loadContacts() async {
        do {
            contacts = try await service.fetchContacts()
        } catch {
            contacts = []
        }
    }

    @MainActor
    func loadGroups() async {
        do {
            groups = try await service.fetchGroups()
        } catch {
            groups = []
        }
    }

    // MARK: - Sync

    @MainActor
    func sync(days: Int = 7) async {
        isSyncing = true
        lastSyncMessage = nil

        do {
            let result = try await service.sync(days: days)
            lastSyncMessage = "Synced \(result.messagesAdded) new messages"
            lastSyncedAt = Date()
            await loadContacts()
            await loadGroups()
            await loadChatMetadata()
            await loadActions()
        } catch is URLError {
            lastSyncMessage = "Sync failed: cannot connect to server"
        } catch {
            lastSyncMessage = "Sync failed: \(error.localizedDescription)"
        }

        isSyncing = false
    }

    @MainActor
    func hardReset() async {
        // Clear all state immediately so the UI reflects the reset
        isSyncing = true
        lastSyncMessage = "Resetting database..."
        lastSyncedAt = nil
        chatMetadata = []
        keyEvents = []
        tasks = []
        completedTasks = []
        removedEvents = []
        results = []
        contacts = []
        groups = []

        do {
            // Trigger the hard reset — server returns immediately
            _ = try await service.sync(days: 7, hardReset: true)

            // Poll health endpoint until the reset finishes
            lastSyncMessage = "Hard reset in progress..."
            while true {
                try await Task.sleep(nanoseconds: 2_000_000_000) // 2 seconds
                let health = try await service.fetchHealth()
                if health.ready && !health.syncing {
                    break
                }
                lastSyncMessage = progressMessage(health.progress)
            }

            lastSyncMessage = "Hard reset complete"
            lastSyncedAt = Date()
            await loadContacts()
            await loadGroups()
            await loadChatMetadata()
            await loadActions()
        } catch is CancellationError {
            lastSyncMessage = "Hard reset cancelled"
        } catch is URLError {
            lastSyncMessage = "Hard reset failed: cannot connect to server"
        } catch {
            lastSyncMessage = "Hard reset failed: \(error.localizedDescription)"
        }

        isSyncing = false

        // Signal ContentView to show onboarding after reset is fully complete
        didCompleteHardReset = true
    }

    // MARK: - Thread

    @MainActor
    func openThread(for messageId: Int) async {
        threadAnchorId = messageId
        isLoadingThread = true
        threadError = nil
        threadResponse = nil

        do {
            threadResponse = try await service.fetchThread(messageId: messageId)
        } catch is URLError {
            threadError = "Cannot connect to server. Make sure `npm run serve` is running."
        } catch {
            threadError = error.localizedDescription
        }

        isLoadingThread = false
    }

    @MainActor
    func loadMoreThread(direction: String) async {
        guard let response = threadResponse,
              let anchorId = threadAnchorId else { return }

        let cursor = direction == "older" ? response.cursors.older : response.cursors.newer
        guard let cursor else { return }

        isLoadingMoreThread = true

        do {
            let page = try await service.fetchThread(
                messageId: anchorId,
                cursor: cursor,
                direction: direction
            )

            if direction == "older" {
                threadResponse = ThreadResponse(
                    chat: response.chat,
                    anchor_message_id: response.anchor_message_id,
                    messages: page.messages + response.messages,
                    cursors: ThreadCursors(older: page.cursors.older, newer: response.cursors.newer),
                    has_older: page.has_older,
                    has_newer: response.has_newer
                )
            } else {
                threadResponse = ThreadResponse(
                    chat: response.chat,
                    anchor_message_id: response.anchor_message_id,
                    messages: response.messages + page.messages,
                    cursors: ThreadCursors(older: response.cursors.older, newer: page.cursors.newer),
                    has_older: response.has_older,
                    has_newer: page.has_newer
                )
            }
        } catch {
            // Silently fail pagination — the user can retry
        }

        isLoadingMoreThread = false
    }

    func closeThread() {
        threadAnchorId = nil
        threadResponse = nil
        threadError = nil
    }

    // MARK: - Chat Metadata

    @MainActor
    func loadChatMetadata() async {
        isLoadingMetadata = true
        do {
            chatMetadata = try await service.fetchChatMetadata()
        } catch {
            chatMetadata = []
        }
        isLoadingMetadata = false
    }

    @Published private(set) var refreshingMetadataChats: Set<Int> = []

    @MainActor
    func refreshChatMetadata(chatId: Int) async {
        refreshingMetadataChats.insert(chatId)
        do {
            let result = try await service.refreshChatMetadata(chatId: chatId)
            if let idx = chatMetadata.firstIndex(where: { $0.chat_id == chatId }) {
                chatMetadata[idx] = ChatMetadata(
                    chat_id: result.chat_id,
                    summary: result.summary,
                    last_updated: Date(),
                    chat_name: chatMetadata[idx].chat_name,
                    latest_message_date: chatMetadata[idx].latest_message_date
                )
            }
        } catch {
            // Silently fail — user can retry
        }
        refreshingMetadataChats.remove(chatId)
    }

    // MARK: - Actions

    @MainActor
    func loadActions() async {
        isLoadingActions = true
        do {
            let response = try await service.fetchActions()
            keyEvents = response.key_events
            tasks = response.tasks
        } catch {
            keyEvents = []
            tasks = []
        }
        isLoadingActions = false
    }

    @MainActor
    func loadCompletedActions() async {
        do {
            let response = try await service.fetchActions(includeCompleted: true)
            completedTasks = response.tasks.filter { $0.completed }
            removedEvents = response.key_events.filter { $0.removed == true }
        } catch {
            completedTasks = []
            removedEvents = []
        }
    }

    @MainActor
    func completeTask(id: Int) async {
        do {
            try await service.completeTask(id: id)
            if let task = tasks.first(where: { $0.id == id }) {
                completedTasks.insert(task, at: 0)
            }
            tasks.removeAll { $0.id == id }
        } catch {
            // Silently fail — user can retry
        }
    }

    @MainActor
    func deleteEvent(id: Int) async {
        do {
            try await service.deleteEvent(id: id)
            if let event = keyEvents.first(where: { $0.id == id }) {
                removedEvents.insert(event, at: 0)
            }
            keyEvents.removeAll { $0.id == id }
        } catch {
            // Silently fail — user can retry
        }
    }

    // MARK: - Settings

    func fetchSettings() async throws -> SearchService.SettingsResponse {
        try await service.fetchSettings()
    }

    func fetchModels() async throws -> [SearchService.ModelOption] {
        try await service.fetchModels()
    }

    func updateSettings(_ updates: [String: String]) async throws {
        try await service.updateSettings(updates)
    }

    // MARK: - Debug Logs

    @Published private(set) var debugLogs: [SearchService.LogEntry] = []
    @Published private(set) var isLoadingLogs: Bool = false

    @MainActor
    func loadDebugLogs() async {
        isLoadingLogs = true
        do {
            debugLogs = try await service.fetchLogs(limit: 300)
        } catch {
            debugLogs = []
        }
        isLoadingLogs = false
    }

    // MARK: - Context

    @MainActor
    func toggleContext(for result: SearchResult) async {
        if expandedResults.contains(result.id) {
            expandedResults.remove(result.id)
            return
        }

        expandedResults.insert(result.id)

        if contextMessages[result.id] != nil { return }

        loadingContext.insert(result.id)
        do {
            let messages = try await service.fetchContext(messageId: result.id)
            contextMessages[result.id] = messages
        } catch {
            contextMessages[result.id] = []
        }
        loadingContext.remove(result.id)
    }
}
