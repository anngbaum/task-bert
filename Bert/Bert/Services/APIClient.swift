import Foundation

actor APIClient {
    private let baseURL = URL(string: "http://localhost:11488")!

    /// Bearer token read from the server's auth-token file.
    /// Loaded lazily on first request and cached.
    private var authToken: String?

    private func loadAuthTokenIfNeeded() {
        guard authToken == nil else { return }
        let appSupport = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        let tokenPath = appSupport.appendingPathComponent("Bert/auth-token").path
        authToken = try? String(contentsOfFile: tokenPath, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Reset the cached token (call after server restart to pick up new token)
    func resetAuthToken() {
        authToken = nil
    }

    private func authorizedRequest(url: URL, method: String = "GET") -> URLRequest {
        loadAuthTokenIfNeeded()
        var request = URLRequest(url: url)
        request.httpMethod = method
        if let token = authToken {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        return request
    }

    /// GET with auth header. Retries once on 401 with a fresh token.
    private func authData(from url: URL) async throws -> (Data, URLResponse) {
        let request = authorizedRequest(url: url)
        let (data, response) = try await URLSession.shared.data(for: request)
        if let http = response as? HTTPURLResponse, http.statusCode == 401 {
            authToken = nil
            let retry = authorizedRequest(url: url)
            return try await URLSession.shared.data(for: retry)
        }
        return (data, response)
    }

    /// Request with auth header. Retries once on 401 with a fresh token.
    private func authData(for request: URLRequest) async throws -> (Data, URLResponse) {
        var req = request
        loadAuthTokenIfNeeded()
        if let token = authToken {
            req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        let (data, response) = try await URLSession.shared.data(for: req)
        if let http = response as? HTTPURLResponse, http.statusCode == 401 {
            authToken = nil
            var retry = request
            loadAuthTokenIfNeeded()
            if let token = authToken {
                retry.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            }
            return try await URLSession.shared.data(for: retry)
        }
        return (data, response)
    }

    /// Streaming bytes with auth header
    private func authBytes(for request: URLRequest) async throws -> (URLSession.AsyncBytes, URLResponse) {
        var req = request
        loadAuthTokenIfNeeded()
        if let token = authToken {
            req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        return try await URLSession.shared.bytes(for: req)
    }

    private let decoder: JSONDecoder = {
        let d = JSONDecoder()
        d.dateDecodingStrategy = .custom { decoder in
            let container = try decoder.singleValueContainer()
            let str = try container.decode(String.self)

            // Try ISO 8601 with fractional seconds
            let iso = ISO8601DateFormatter()
            iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            if let date = iso.date(from: str) { return date }

            // Try without fractional seconds
            iso.formatOptions = [.withInternetDateTime]
            if let date = iso.date(from: str) { return date }

            // Try JavaScript-style date string
            let jsFormatter = DateFormatter()
            jsFormatter.locale = Locale(identifier: "en_US_POSIX")
            jsFormatter.dateFormat = "yyyy-MM-dd'T'HH:mm:ss.SSSZ"
            if let date = jsFormatter.date(from: str) { return date }

            throw DecodingError.dataCorruptedError(
                in: container,
                debugDescription: "Cannot decode date: \(str)"
            )
        }
        return d
    }()

    struct SyncResponse: Decodable {
        let messagesAdded: Int?
        let handlesAdded: Int?
        let lastSynced: String?
        let started: Bool?
        let hardReset: Bool?
    }

    struct HealthProgress: Decodable {
        let stage: String
        let detail: String
        let percent: Double
    }

    struct EmbeddingProgress: Decodable {
        let isRunning: Bool
        let total: Int
        let processed: Int
    }

    struct ApiKeyErrorInfo: Decodable {
        let provider: String
        let message: String
    }

    struct HealthResponse: Decodable {
        let status: String
        let ready: Bool
        let syncing: Bool
        let progress: HealthProgress?
        let needsApiKeys: Bool?
        let embedding: EmbeddingProgress?
        let apiKeyError: ApiKeyErrorInfo?
    }

    struct ContactsResponse: Decodable {
        let contacts: [Contact]
    }

    struct GroupsResponse: Decodable {
        let groups: [GroupChat]
    }

    struct SearchResponse: Decodable {
        let results: [SearchResult]
        let count: Int
        let hasMore: Bool
        let mode: String
    }

    struct ContextResponse: Decodable {
        let messages: [ContextMessage]
        let count: Int
    }

    func search(
        query: String,
        mode: SearchMode,
        filters: SearchFilters,
        limit: Int = 20,
        offset: Int = 0
    ) async throws -> SearchResponse {
        var components = URLComponents(url: baseURL.appendingPathComponent("api/search"), resolvingAgainstBaseURL: false)!

        var queryItems: [URLQueryItem] = [
            URLQueryItem(name: "q", value: query),
            URLQueryItem(name: "mode", value: mode.rawValue),
            URLQueryItem(name: "limit", value: String(limit)),
            URLQueryItem(name: "offset", value: String(offset)),
        ]

        if !filters.sentByContacts.isEmpty {
            queryItems.append(URLQueryItem(name: "from", value: filters.sentByString))
        }
        for contact in filters.withContacts {
            queryItems.append(URLQueryItem(name: "withContact", value: contact.name))
        }
        if let group = filters.groupChat {
            queryItems.append(URLQueryItem(name: "groupChatName", value: group.name))
        }
        if let after = filters.effectiveAfterDate {
            queryItems.append(URLQueryItem(name: "after", value: ISO8601DateFormatter().string(from: after)))
        }
        if let before = filters.effectiveBeforeDate {
            queryItems.append(URLQueryItem(name: "before", value: ISO8601DateFormatter().string(from: before)))
        }
        if filters.sentByMe {
            queryItems.append(URLQueryItem(name: "fromMe", value: "true"))
        }

        components.queryItems = queryItems

        let (data, response) = try await authData(from: components.url!)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            let http = response as? HTTPURLResponse
            throw SearchError.serverError(statusCode: http?.statusCode ?? 0)
        }

        return try decoder.decode(SearchResponse.self, from: data)
    }

    func fetchContacts() async throws -> [Contact] {
        let url = baseURL.appendingPathComponent("api/contacts")
        let (data, response) = try await authData(from: url)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            let http = response as? HTTPURLResponse
            throw SearchError.serverError(statusCode: http?.statusCode ?? 0)
        }
        let contactsResponse = try decoder.decode(ContactsResponse.self, from: data)
        return contactsResponse.contacts
    }

    func fetchGroups() async throws -> [GroupChat] {
        let url = baseURL.appendingPathComponent("api/groups")
        let (data, response) = try await authData(from: url)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            let http = response as? HTTPURLResponse
            throw SearchError.serverError(statusCode: http?.statusCode ?? 0)
        }
        let groupsResponse = try decoder.decode(GroupsResponse.self, from: data)
        return groupsResponse.groups
    }

    func sync(days: Int = 7, hardReset: Bool = false) async throws -> SyncResponse {
        var components = URLComponents(url: baseURL.appendingPathComponent("api/sync"), resolvingAgainstBaseURL: false)!
        var queryItems = [URLQueryItem(name: "days", value: String(days))]
        if hardReset {
            queryItems.append(URLQueryItem(name: "hardReset", value: "true"))
        }
        components.queryItems = queryItems
        var request = URLRequest(url: components.url!)
        request.httpMethod = "POST"
        request.timeoutInterval = 600 // Hard reset can take longer
        let (data, response) = try await authData(for: request)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            let http = response as? HTTPURLResponse
            throw SearchError.serverError(statusCode: http?.statusCode ?? 0)
        }
        return try decoder.decode(SyncResponse.self, from: data)
    }

    func softReset() async throws {
        var request = URLRequest(url: baseURL.appendingPathComponent("api/soft-reset"))
        request.httpMethod = "POST"
        request.timeoutInterval = 600
        let (_, response) = try await authData(for: request)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            let http = response as? HTTPURLResponse
            throw SearchError.serverError(statusCode: http?.statusCode ?? 0)
        }
    }

    struct ImportOlderStarted: Decodable {
        let started: Bool
        let since: String
    }

    /// Kicks off import in the background. Returns immediately — poll /health for progress.
    func startImportOlderMessages(since: Date) async throws {
        let iso = ISO8601DateFormatter().string(from: since)
        var components = URLComponents(url: baseURL.appendingPathComponent("api/import-older"), resolvingAgainstBaseURL: false)!
        components.queryItems = [URLQueryItem(name: "since", value: iso)]
        var request = URLRequest(url: components.url!)
        request.httpMethod = "POST"
        request.timeoutInterval = 30
        let (_, response) = try await authData(for: request)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            let http = response as? HTTPURLResponse
            throw SearchError.serverError(statusCode: http?.statusCode ?? 0)
        }
    }

    struct DataRangeResponse: Decodable {
        let earliest: String?
        let latest: String?
        let days_covered: Int?
        let total_messages: Int?
    }

    func fetchDataRange() async throws -> DataRangeResponse {
        let url = baseURL.appendingPathComponent("api/data-range")
        let (data, response) = try await authData(from: url)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            let http = response as? HTTPURLResponse
            throw SearchError.serverError(statusCode: http?.statusCode ?? 0)
        }
        return try decoder.decode(DataRangeResponse.self, from: data)
    }

    func fetchHealth() async throws -> HealthResponse {
        let url = baseURL.appendingPathComponent("health")
        let (data, response) = try await authData(from: url)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            let http = response as? HTTPURLResponse
            throw SearchError.serverError(statusCode: http?.statusCode ?? 0)
        }
        return try decoder.decode(HealthResponse.self, from: data)
    }

    func fetchThread(
        messageId: Int,
        before: Int? = nil,
        after: Int? = nil,
        cursor: String? = nil,
        direction: String? = nil,
        limit: Int? = nil
    ) async throws -> ThreadResponse {
        var components = URLComponents(url: baseURL.appendingPathComponent("api/thread"), resolvingAgainstBaseURL: false)!
        var queryItems: [URLQueryItem] = [
            URLQueryItem(name: "messageId", value: String(messageId)),
        ]
        if let before { queryItems.append(URLQueryItem(name: "before", value: String(before))) }
        if let after { queryItems.append(URLQueryItem(name: "after", value: String(after))) }
        if let cursor { queryItems.append(URLQueryItem(name: "cursor", value: cursor)) }
        if let direction { queryItems.append(URLQueryItem(name: "direction", value: direction)) }
        if let limit { queryItems.append(URLQueryItem(name: "limit", value: String(limit))) }
        components.queryItems = queryItems

        let (data, response) = try await authData(from: components.url!)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            let http = response as? HTTPURLResponse
            throw SearchError.serverError(statusCode: http?.statusCode ?? 0)
        }

        return try decoder.decode(ThreadResponse.self, from: data)
    }

    struct ChatMetadataResponse: Decodable {
        let metadata: [ChatMetadata]
    }

    func fetchChatMetadata() async throws -> [ChatMetadata] {
        let url = baseURL.appendingPathComponent("api/chat-metadata")
        let (data, response) = try await authData(from: url)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            let http = response as? HTTPURLResponse
            throw SearchError.serverError(statusCode: http?.statusCode ?? 0)
        }
        return try decoder.decode(ChatMetadataResponse.self, from: data).metadata
    }

    func fetchLeaderboard(chatId: Int) async throws -> LeaderboardResponse {
        var components = URLComponents(url: baseURL.appendingPathComponent("api/chat-leaderboard"), resolvingAgainstBaseURL: false)!
        components.queryItems = [URLQueryItem(name: "chatId", value: String(chatId))]
        let (data, response) = try await authData(from: components.url!)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            let http = response as? HTTPURLResponse
            throw SearchError.serverError(statusCode: http?.statusCode ?? 0)
        }
        return try decoder.decode(LeaderboardResponse.self, from: data)
    }

    struct RefreshMetadataResponse: Decodable {
        let chat_id: Int
        let summary: String
    }

    func refreshChatMetadata(chatId: Int) async throws -> RefreshMetadataResponse {
        var components = URLComponents(url: baseURL.appendingPathComponent("api/chat-metadata/refresh"), resolvingAgainstBaseURL: false)!
        components.queryItems = [URLQueryItem(name: "chatId", value: String(chatId))]
        var request = URLRequest(url: components.url!)
        request.httpMethod = "POST"
        let (data, response) = try await authData(for: request)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            let http = response as? HTTPURLResponse
            throw SearchError.serverError(statusCode: http?.statusCode ?? 0)
        }
        return try decoder.decode(RefreshMetadataResponse.self, from: data)
    }

    struct ActionsResponse: Decodable {
        let key_events: [KeyEvent]
        let tasks: [TaskItem]
    }

    func moveTask(id: Int, bucket: String, date: Date? = nil) async throws {
        let url = baseURL.appendingPathComponent("api/tasks/move")
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

        var body: [String: Any] = ["id": id, "bucket": bucket]
        if let date {
            body["date"] = ISO8601DateFormatter().string(from: date)
        }
        request.httpBody = try JSONSerialization.data(withJSONObject: body)

        let (_, response) = try await authData(for: request)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            let http = response as? HTTPURLResponse
            throw SearchError.serverError(statusCode: http?.statusCode ?? 0)
        }
    }

    func setTaskPriority(id: Int, priority: String) async throws {
        var components = URLComponents(url: baseURL.appendingPathComponent("api/tasks/set-priority"), resolvingAgainstBaseURL: false)!
        components.queryItems = [
            URLQueryItem(name: "id", value: String(id)),
            URLQueryItem(name: "priority", value: priority),
        ]
        var request = URLRequest(url: components.url!)
        request.httpMethod = "POST"
        let (_, response) = try await authData(for: request)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            let http = response as? HTTPURLResponse
            throw SearchError.serverError(statusCode: http?.statusCode ?? 0)
        }
    }

    func completeTask(id: Int) async throws {
        var components = URLComponents(url: baseURL.appendingPathComponent("api/actions/complete"), resolvingAgainstBaseURL: false)!
        components.queryItems = [
            URLQueryItem(name: "id", value: String(id)),
        ]
        var request = URLRequest(url: components.url!)
        request.httpMethod = "POST"
        let (_, response) = try await authData(for: request)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            let http = response as? HTTPURLResponse
            throw SearchError.serverError(statusCode: http?.statusCode ?? 0)
        }
    }

    func deleteEvent(id: Int) async throws {
        var components = URLComponents(url: baseURL.appendingPathComponent("api/events/delete"), resolvingAgainstBaseURL: false)!
        components.queryItems = [URLQueryItem(name: "id", value: String(id))]
        var request = URLRequest(url: components.url!)
        request.httpMethod = "POST"
        let (_, response) = try await authData(for: request)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            let http = response as? HTTPURLResponse
            throw SearchError.serverError(statusCode: http?.statusCode ?? 0)
        }
    }

    func updateEvent(id: Int, title: String, date: Date?, location: String?) async throws {
        let url = baseURL.appendingPathComponent("api/events/update")
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

        var body: [String: Any] = ["id": id, "title": title]
        if let date {
            body["date"] = ISO8601DateFormatter().string(from: date)
        } else {
            body["date"] = NSNull()
        }
        body["location"] = location ?? NSNull()
        request.httpBody = try JSONSerialization.data(withJSONObject: body)

        let (_, response) = try await authData(for: request)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            let http = response as? HTTPURLResponse
            throw SearchError.serverError(statusCode: http?.statusCode ?? 0)
        }
    }

    func fetchEventMessage(eventId: Int) async throws -> String? {
        var components = URLComponents(url: baseURL.appendingPathComponent("api/events/message"), resolvingAgainstBaseURL: false)!
        components.queryItems = [URLQueryItem(name: "id", value: String(eventId))]
        let (data, response) = try await authData(from: components.url!)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            return nil
        }
        let result = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        return result?["text"] as? String
    }

    func createTask(title: String, date: Date?, priority: String, chatId: Int?) async throws {
        let url = baseURL.appendingPathComponent("api/tasks/create")
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

        var body: [String: Any] = ["title": title, "priority": priority]
        if let date {
            body["date"] = ISO8601DateFormatter().string(from: date)
        }
        if let chatId {
            body["chat_id"] = chatId
        }
        request.httpBody = try JSONSerialization.data(withJSONObject: body)

        let (_, response) = try await authData(for: request)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            let http = response as? HTTPURLResponse
            throw SearchError.serverError(statusCode: http?.statusCode ?? 0)
        }
    }

    func setReminderId(taskId: Int, reminderId: String?) async throws {
        var components = URLComponents(url: baseURL.appendingPathComponent("api/tasks/set-reminder"), resolvingAgainstBaseURL: false)!
        var queryItems = [URLQueryItem(name: "id", value: String(taskId))]
        if let reminderId {
            queryItems.append(URLQueryItem(name: "reminderId", value: reminderId))
        }
        components.queryItems = queryItems
        var request = URLRequest(url: components.url!)
        request.httpMethod = "POST"
        let (_, response) = try await authData(for: request)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            let http = response as? HTTPURLResponse
            throw SearchError.serverError(statusCode: http?.statusCode ?? 0)
        }
    }

    func fetchActions(includeCompleted: Bool = false) async throws -> ActionsResponse {
        var components = URLComponents(url: baseURL.appendingPathComponent("api/actions"), resolvingAgainstBaseURL: false)!
        if includeCompleted {
            components.queryItems = [URLQueryItem(name: "completed", value: "true")]
        }
        let (data, response) = try await authData(from: components.url!)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            let http = response as? HTTPURLResponse
            throw SearchError.serverError(statusCode: http?.statusCode ?? 0)
        }
        return try decoder.decode(ActionsResponse.self, from: data)
    }

    // MARK: - Agent

    struct AgentMessageLink: Decodable, Identifiable {
        let message_id: Int
        let text: String
        let sender: String
        let date: String?
        let chat_name: String?

        var id: Int { message_id }
    }

    struct DataRange: Decodable {
        let earliest: String?
        let latest: String?
        let days_covered: Int?
    }

    struct AgentResponse: Decodable {
        let answer: String
        let message_links: [AgentMessageLink]
        let tool_calls_count: Int
        let data_range: DataRange?

        enum CodingKeys: String, CodingKey {
            case answer, message_links, tool_calls_count, data_range
        }
    }

    struct AgentProgressEvent {
        let eventType: String   // "thinking", "tool_call", "tool_result"
        let description: String
        let tool: String?
        let resultSummary: String?
    }

    /// Streams the agent response. Calls onProgress for each progress event, returns final AgentResponse.
    func runAgentStreaming(query: String, onProgress: @Sendable @escaping (AgentProgressEvent) -> Void) async throws -> AgentResponse {
        let url = baseURL.appendingPathComponent("api/agent")
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.timeoutInterval = 120
        request.httpBody = try JSONSerialization.data(withJSONObject: ["query": query])

        let (bytes, response) = try await authBytes(for: request)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            let http = response as? HTTPURLResponse
            throw SearchError.serverError(statusCode: http?.statusCode ?? 0)
        }

        var finalResponse: AgentResponse?

        for try await line in bytes.lines {
            guard !line.isEmpty else { continue }
            guard let data = line.data(using: .utf8) else { continue }
            guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let stream = json["stream"] as? String else { continue }

            switch stream {
            case "progress":
                let event = AgentProgressEvent(
                    eventType: json["event_type"] as? String ?? "",
                    description: json["description"] as? String ?? "",
                    tool: json["tool"] as? String,
                    resultSummary: json["result_summary"] as? String
                )
                onProgress(event)
            case "result":
                finalResponse = try decoder.decode(AgentResponse.self, from: data)
            case "error":
                let message = json["message"] as? String ?? "Unknown agent error"
                throw SearchError.serverError(statusCode: 500)
            default:
                break
            }
        }

        guard let result = finalResponse else {
            throw SearchError.serverError(statusCode: 500)
        }
        return result
    }

    struct SettingsResponse: Decodable {
        let hasAnthropicKey: Bool?
        let hasOpenaiKey: Bool?
        let selectedModel: String?
        let actionsModel: String?
        let summaryModel: String?
        let askModel: String?
        let apiKeyError: ApiKeyErrorInfo?
    }

    struct ModelOption: Decodable, Identifiable {
        let id: String
        let name: String
        let provider: String
        let available: Bool
    }

    struct ModelsResponse: Decodable {
        let models: [ModelOption]
    }

    func fetchSettings() async throws -> SettingsResponse {
        let url = baseURL.appendingPathComponent("api/settings")
        let (data, response) = try await authData(from: url)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            let http = response as? HTTPURLResponse
            throw SearchError.serverError(statusCode: http?.statusCode ?? 0)
        }
        return try decoder.decode(SettingsResponse.self, from: data)
    }

    func fetchModels() async throws -> [ModelOption] {
        let url = baseURL.appendingPathComponent("api/models")
        let (data, response) = try await authData(from: url)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            let http = response as? HTTPURLResponse
            throw SearchError.serverError(statusCode: http?.statusCode ?? 0)
        }
        return try decoder.decode(ModelsResponse.self, from: data).models
    }

    func updateSettings(_ updates: [String: String]) async throws {
        let url = baseURL.appendingPathComponent("api/settings")
        var request = URLRequest(url: url)
        request.httpMethod = "PUT"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: updates)
        let (_, response) = try await authData(for: request)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            let http = response as? HTTPURLResponse
            throw SearchError.serverError(statusCode: http?.statusCode ?? 0)
        }
    }

    struct ValidateKeyResponse: Decodable {
        let valid: Bool
        let error: String?
    }

    func validateKey(provider: String, apiKey: String) async throws -> ValidateKeyResponse {
        let url = baseURL.appendingPathComponent("api/validate-key")
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.timeoutInterval = 30
        request.httpBody = try JSONSerialization.data(withJSONObject: ["provider": provider, "apiKey": apiKey])
        let (data, response) = try await authData(for: request)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            let http = response as? HTTPURLResponse
            throw SearchError.serverError(statusCode: http?.statusCode ?? 0)
        }
        return try decoder.decode(ValidateKeyResponse.self, from: data)
    }

    // MARK: - Debug Logs

    struct LogEntry: Decodable, Identifiable {
        let ts: String
        let level: String
        let message: String

        var id: String { "\(ts)-\(message.prefix(40))" }
    }

    private struct LogsResponse: Decodable {
        let logs: [LogEntry]
    }

    func fetchLogs(limit: Int = 200) async throws -> [LogEntry] {
        var components = URLComponents(url: baseURL.appendingPathComponent("api/logs"), resolvingAgainstBaseURL: false)!
        components.queryItems = [URLQueryItem(name: "limit", value: String(limit))]
        let (data, response) = try await authData(from: components.url!)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            let http = response as? HTTPURLResponse
            throw SearchError.serverError(statusCode: http?.statusCode ?? 0)
        }
        return try decoder.decode(LogsResponse.self, from: data).logs
    }

    func fetchContext(messageId: Int, before: Int = 3, after: Int = 10) async throws -> [ContextMessage] {
        var components = URLComponents(url: baseURL.appendingPathComponent("api/context"), resolvingAgainstBaseURL: false)!
        components.queryItems = [
            URLQueryItem(name: "messageId", value: String(messageId)),
            URLQueryItem(name: "before", value: String(before)),
            URLQueryItem(name: "after", value: String(after)),
        ]

        let (data, response) = try await authData(from: components.url!)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            let http = response as? HTTPURLResponse
            throw SearchError.serverError(statusCode: http?.statusCode ?? 0)
        }

        let contextResponse = try decoder.decode(ContextResponse.self, from: data)
        return contextResponse.messages
    }
}

enum SearchError: LocalizedError {
    case serverError(statusCode: Int)
    case serverUnavailable

    var errorDescription: String? {
        switch self {
        case .serverError(let code):
            "Server returned status \(code)"
        case .serverUnavailable:
            "Cannot connect to server."
        }
    }
}
