import SwiftUI

enum AppTab: String, CaseIterable, Identifiable {
    case actions = "Tasks"
    case events = "Events"
    case conversations = "Recent Conversations"
    case search = "Search"
    case agent = "Ask"

    var id: String { rawValue }

    var icon: String {
        switch self {
        case .actions: "checklist"
        case .events: "calendar.badge.clock"
        case .conversations: "bubble.left.and.text.bubble.right"
        case .search: "magnifyingglass"
        case .agent: "sparkles"
        }
    }
}

struct ContentView: View {
    @StateObject private var viewModel = SearchViewModel()
    @State private var selectedTab: AppTab = .actions
    @State private var showSettings: Bool = false
    @AppStorage("hasCompletedOnboarding") private var hasCompletedOnboarding: Bool = false
    @AppStorage("hasCompletedTaskTriage") private var hasCompletedTaskTriage: Bool = false
    @State private var onboardingPhase: OnboardingPhase = .apiKeyPrompt

    enum OnboardingPhase {
        case apiKeyPrompt       // No key yet — show entry screen with Skip
        case updatingMetadata   // Key just entered — generating summaries
        case taskReview         // Metadata done — review tasks
    }

    var body: some View {
        VStack(spacing: 0) {
            if !hasCompletedOnboarding {
                switch onboardingPhase {
                case .apiKeyPrompt:
                    OnboardingApiKeyView(viewModel: viewModel) { didEnterKey in
                        print("[onboarding] apiKeyPrompt completed: didEnterKey=\(didEnterKey), hasApiKey=\(viewModel.hasApiKey)")
                        if didEnterKey && viewModel.hasApiKey {
                            onboardingPhase = .updatingMetadata
                        } else {
                            hasCompletedOnboarding = true
                        }
                    }
                case .updatingMetadata:
                    OnboardingMetadataView(viewModel: viewModel) {
                        onboardingPhase = .taskReview
                    }
                case .taskReview:
                    TaskTriageView(viewModel: viewModel) {
                        hasCompletedOnboarding = true
                        hasCompletedTaskTriage = true
                    }
                }
            } else if !hasCompletedTaskTriage && viewModel.hasApiKey {
                TaskTriageView(viewModel: viewModel) {
                    hasCompletedTaskTriage = true
                }
            } else {
                ZStack {
                    // Main content — kept alive so scroll position is preserved
                    VStack(spacing: 0) {
                        // Top bar: tabs on the left, sync + settings on the right
                        HStack(spacing: 0) {
                            ForEach(AppTab.allCases) { tab in
                                tabButton(tab)
                            }

                            Spacer()

                            syncButton
                            settingsButton
                        }
                        .padding(.horizontal, 12)
                        .padding(.vertical, 8)

                        Divider()

                        if viewModel.isSyncing {
                            HStack(spacing: 6) {
                                ProgressView()
                                    .controlSize(.mini)
                                Text(viewModel.lastSyncMessage ?? "Sync in progress. Not all of your data has been imported yet.")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 6)
                            .background(AppColors.syncBanner)
                        }

                        // Content for selected tab
                        switch selectedTab {
                        case .conversations:
                            if viewModel.hasApiKey {
                                ChatMetadataPanelView(viewModel: viewModel)
                            } else {
                                apiKeyRequiredView
                            }
                        case .actions:
                            if viewModel.hasApiKey {
                                ActionsPanelView(viewModel: viewModel)
                            } else {
                                apiKeyRequiredView
                            }
                        case .events:
                            if viewModel.hasApiKey {
                                EventsPanelView(viewModel: viewModel)
                            } else {
                                apiKeyRequiredView
                            }
                        case .search:
                            SearchBarView(viewModel: viewModel)
                                .padding(.horizontal)
                                .padding(.top, 8)
                                .zIndex(1)
                            ResultsListView(viewModel: viewModel)
                        case .agent:
                            if viewModel.hasApiKey {
                                AgentView(viewModel: viewModel)
                            } else {
                                apiKeyRequiredView
                            }
                        }
                    }
                    .opacity(viewModel.threadAnchorId == nil ? 1 : 0)
                    .allowsHitTesting(viewModel.threadAnchorId == nil)

                    // Thread detail — overlays when active
                    if viewModel.threadAnchorId != nil {
                        ThreadView(viewModel: viewModel)
                    }

                    // Leaderboard — overlays when active
                    if viewModel.leaderboardChatId != nil {
                        LeaderboardView(
                            viewModel: viewModel,
                            chatName: viewModel.chatMetadata.first(where: { $0.chat_id == viewModel.leaderboardChatId })?.chat_name ?? "Group Chat"
                        )
                        .background(Color(nsColor: .windowBackgroundColor))
                    }
                }
            }
        }
        .sheet(isPresented: $showSettings) {
            SettingsView(viewModel: viewModel)
        }
        .onAppear {
            // If user already has a key (entered during server init), skip to task review
            if !hasCompletedOnboarding && viewModel.hasApiKey {
                onboardingPhase = .taskReview
            }
        }
        .onChange(of: viewModel.hasApiKey) { _ in
            // If key was removed and we're on an LLM tab, switch to search
            if !viewModel.hasApiKey && selectedTab != .search {
                selectedTab = .search
            }
        }
        .onChange(of: viewModel.didStartHardReset) { started in
            if started {
                showSettings = false
                hasCompletedTaskTriage = false
                hasCompletedOnboarding = false
                onboardingPhase = viewModel.hasApiKey ? .taskReview : .apiKeyPrompt
                viewModel.didStartHardReset = false
            }
        }
        .frame(minWidth: 600, minHeight: 400)
    }

    private var apiKeyRequiredView: some View {
        VStack(spacing: 16) {
            Image(systemName: "key")
                .font(.system(size: 48))
                .foregroundStyle(.tertiary)
            Text("API Key Required")
                .font(.title3)
                .foregroundStyle(.secondary)
            Text("Add an Anthropic or OpenAI API key in Settings to enable conversation summaries and action items.")
                .font(.caption)
                .foregroundStyle(.tertiary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 60)
            Button("Open Settings") {
                showSettings = true
            }
            .buttonStyle(.borderedProminent)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func tabButton(_ tab: AppTab) -> some View {
        let requiresKey = (tab == .actions || tab == .events || tab == .conversations || tab == .agent)
        let disabled = requiresKey && !viewModel.hasApiKey

        return Button {
            withAnimation(.easeInOut(duration: 0.15)) {
                selectedTab = tab
            }
        } label: {
            HStack(spacing: 5) {
                Image(systemName: tab.icon)
                    .font(.caption)
                Text(tab.rawValue)
                    .font(.caption)
                    .fontWeight(.medium)

                if tab == .conversations && !viewModel.chatMetadata.isEmpty {
                    badgeView(count: viewModel.chatMetadata.count, color: AppColors.badgeConversations)
                }
                if tab == .actions {
                    let todoCount = viewModel.tasks.filter { $0.resolvedBucket == "todo" }.count
                    if todoCount > 0 {
                        badgeView(count: todoCount, color: AppColors.badgeActions)
                    }
                }
                if tab == .events && !viewModel.keyEvents.isEmpty {
                    badgeView(count: viewModel.keyEvents.count, color: AppColors.badgeEvents)
                }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(selectedTab == tab ? AppColors.selectedTab : Color.clear)
            .foregroundColor(disabled ? Color.gray : (selectedTab == tab ? Color.accentColor : Color.secondary))
            .clipShape(RoundedRectangle(cornerRadius: 6))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(disabled)
        .help(disabled ? "Add an API key in Settings to use this feature" : tab.rawValue)
    }

    private func badgeView(count: Int, color: Color) -> some View {
        Text("\(count)")
            .font(.caption2)
            .fontWeight(.semibold)
            .padding(.horizontal, 5)
            .padding(.vertical, 1)
            .background(color.opacity(0.2))
            .foregroundStyle(color)
            .clipShape(Capsule())
    }

    private var syncButton: some View {
        HStack(spacing: 6) {
            if viewModel.isSyncing {
                ProgressView()
                    .controlSize(.small)
                if let message = viewModel.lastSyncMessage {
                    Text(message)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            } else {
                Menu {
                    Button("Last 3 days") { Task { await viewModel.sync(days: 3) } }
                    Button("Last 7 days") { Task { await viewModel.sync(days: 7) } }
                    Button("Last 14 days") { Task { await viewModel.sync(days: 14) } }
                    Button("Last 30 days") { Task { await viewModel.sync(days: 30) } }
                } label: {
                    Image(systemName: "arrow.triangle.2.circlepath")
                        .font(.title3)
                } primaryAction: {
                    Task { await viewModel.sync() }
                }
                .menuStyle(.borderlessButton)
                .fixedSize()
            }
        }
        .disabled(viewModel.isSyncing)
        .help(viewModel.syncTooltip)
        .padding(.trailing, 8)
    }

    private var settingsButton: some View {
        Button {
            showSettings = true
        } label: {
            Image(systemName: "gearshape")
                .font(.title3)
        }
        .buttonStyle(.plain)
        .help("Settings")
    }
}

// MARK: - Onboarding: API Key Prompt

/// Shown after the initial import completes when the user has no API key.
/// Offers to enter a key or skip.
struct OnboardingApiKeyView: View {
    @ObservedObject var viewModel: SearchViewModel
    /// Called with `true` if user entered a key, `false` if they skipped.
    let onComplete: (Bool) -> Void

    @State private var anthropicKeyInput: String = ""
    @State private var openaiKeyInput: String = ""
    @State private var isSaving: Bool = false
    @State private var errorMessage: String? = nil

    var body: some View {
        VStack(spacing: 24) {
            Spacer()

            Image("Broom")
                .resizable()
                .aspectRatio(contentMode: .fit)
                .frame(width: 100, height: 100)

            Text("Hello, I'm Bert.")
                .font(.title)
                .fontWeight(.semibold)

            Text("Add an API key to enable conversation summaries and action item tracking, or skip and use search only.")
                .font(.body)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 40)

            VStack(alignment: .leading, spacing: 16) {
                Text("API key (optional)")
                    .font(.headline)

                Text("You can also add one later in Settings.")
                    .font(.caption)
                    .foregroundStyle(.secondary)

                VStack(alignment: .leading, spacing: 4) {
                    Text("Anthropic API Key")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                    SecureField("sk-ant-...", text: $anthropicKeyInput)
                        .textFieldStyle(.roundedBorder)
                }

                VStack(alignment: .leading, spacing: 4) {
                    Text("OpenAI API Key")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                    SecureField("sk-...", text: $openaiKeyInput)
                        .textFieldStyle(.roundedBorder)
                }

                if let error = errorMessage {
                    Text(error)
                        .font(.caption)
                        .foregroundStyle(AppColors.error)
                }
            }
            .frame(width: 340)

            HStack(spacing: 16) {
                Button("Skip") {
                    onComplete(false)
                }
                .buttonStyle(.bordered)

                Button("Continue") {
                    Task { await saveAndContinue() }
                }
                .buttonStyle(.borderedProminent)
                .disabled(isSaving || (anthropicKeyInput.isEmpty && openaiKeyInput.isEmpty))
            }

            Spacer()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func saveAndContinue() async {
        isSaving = true
        errorMessage = nil

        var updates: [String: String] = [:]
        if !anthropicKeyInput.isEmpty {
            updates["anthropicApiKey"] = anthropicKeyInput
        }
        if !openaiKeyInput.isEmpty {
            updates["openaiApiKey"] = openaiKeyInput
        }

        guard !updates.isEmpty else {
            // No key entered — treat as skip
            isSaving = false
            onComplete(false)
            return
        }

        do {
            if !anthropicKeyInput.isEmpty {
                KeychainManager.anthropicApiKey = anthropicKeyInput
            }
            if !openaiKeyInput.isEmpty {
                KeychainManager.openaiApiKey = openaiKeyInput
            }
            try await viewModel.updateSettings(updates)
            viewModel.hasApiKey = true
        } catch {
            errorMessage = "Failed to save API key. The server may still be starting — try again in a moment."
            isSaving = false
            return
        }

        isSaving = false
        onComplete(true)
    }
}

// MARK: - Onboarding: Metadata Generation Progress

/// Shown after the user enters an API key post-import.
/// Triggers metadata generation (summaries + task extraction) and shows progress.
struct OnboardingMetadataView: View {
    @ObservedObject var viewModel: SearchViewModel
    let onComplete: () -> Void

    @State private var didStart = false

    var body: some View {
        VStack(spacing: 24) {
            Spacer()

            Image("Broom")
                .resizable()
                .aspectRatio(contentMode: .fit)
                .frame(width: 100, height: 100)

            HStack(spacing: 10) {
                Text("Hello, I'm Bert.")
                    .font(.title)
                    .fontWeight(.semibold)
                ProgressView()
                    .controlSize(.small)
            }

            Text(viewModel.lastSyncMessage ?? "Generating conversation summaries...")
                .font(.callout)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 60)

            Spacer()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .onAppear {
            guard !didStart else { return }
            didStart = true
            viewModel.startMetadataGeneration(onComplete: onComplete)
        }
    }
}

#Preview {
    ContentView()
}
