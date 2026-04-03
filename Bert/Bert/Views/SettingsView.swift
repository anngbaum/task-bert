import SwiftUI

struct SettingsView: View {
    @ObservedObject var viewModel: SearchViewModel
    @Environment(\.dismiss) private var dismiss

    @State private var anthropicKeyInput: String = ""
    @State private var openaiKeyInput: String = ""
    @State private var actionsModel: String = ""
    @State private var summaryModel: String = ""
    @State private var askModel: String = ""
    @State private var models: [APIClient.ModelOption] = []
    @State private var maskedAnthropicKey: String? = nil
    @State private var maskedOpenaiKey: String? = nil
    @State private var isSaving: Bool = false
    @State private var isLoading: Bool = true
    @State private var statusMessage: String? = nil
    @State private var showDebugLogs: Bool = false
    @State private var showHardResetConfirm: Bool = false
    @State private var showSoftResetConfirm: Bool = false

    private var availableModels: [APIClient.ModelOption] {
        models.filter { $0.available }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Settings")
                .font(.headline)

            if isLoading {
                ProgressView()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ScrollView {
                    VStack(alignment: .leading, spacing: 20) {
                        apiKeySection(
                            title: "Anthropic API Key",
                            placeholder: "sk-ant-...",
                            input: $anthropicKeyInput,
                            maskedKey: maskedAnthropicKey,
                            helpText: "console.anthropic.com",
                            onRemove: {
                                Task { await removeKey(provider: "anthropic") }
                            }
                        )

                        apiKeySection(
                            title: "OpenAI API Key",
                            placeholder: "sk-...",
                            input: $openaiKeyInput,
                            maskedKey: maskedOpenaiKey,
                            helpText: "platform.openai.com",
                            onRemove: {
                                Task { await removeKey(provider: "openai") }
                            }
                        )

                        Divider()

                        modelPicker

                        Divider()

                        // Sync Reminders
                        VStack(alignment: .leading, spacing: 4) {
                            Toggle(isOn: $viewModel.syncRemindersEnabled) {
                                HStack(spacing: 6) {
                                    Image(systemName: "checklist")
                                        .foregroundStyle(AppColors.settingsSync)
                                    Text("Sync Reminders")
                                }
                            }
                            .toggleStyle(.switch)

                            Text("Export high and low priority tasks to Apple Reminders")
                                .font(.caption)
                                .foregroundStyle(.tertiary)
                        }

                        Divider()

                        HStack {
                            Button {
                                showDebugLogs = true
                            } label: {
                                Label("Server Logs", systemImage: "terminal")
                            }
                            .buttonStyle(.plain)
                            .foregroundStyle(.secondary)
                            .font(.subheadline)

                            Spacer()

                            Button {
                                showSoftResetConfirm = true
                            } label: {
                                Label("Refresh Tasks & Events", systemImage: "arrow.triangle.2.circlepath")
                            }
                            .buttonStyle(.plain)
                            .foregroundStyle(AppColors.settingsRefresh)
                            .font(.subheadline)
                            .disabled(viewModel.isSyncing)

                            Button(role: .destructive) {
                                showHardResetConfirm = true
                            } label: {
                                Label("Hard Reset", systemImage: "arrow.counterclockwise.circle")
                            }
                            .buttonStyle(.plain)
                            .foregroundStyle(AppColors.settingsDestructive)
                            .font(.subheadline)
                            .disabled(viewModel.isSyncing)
                        }

                        if let status = statusMessage {
                            Text(status)
                                .font(.caption)
                                .foregroundStyle(status.contains("Error") ? AppColors.error : AppColors.success)
                        }
                    }
                }
            }

            HStack {
                Spacer()
                Button("Cancel") {
                    dismiss()
                }
                .keyboardShortcut(.cancelAction)
                Button("Save") {
                    Task { await save() }
                }
                .disabled(isSaving)
                .keyboardShortcut(.defaultAction)
            }
        }
        .padding(20)
        .frame(width: 480, height: 640)
        .task { await loadSettings() }
        .sheet(isPresented: $showDebugLogs) {
            DebugLogsView(viewModel: viewModel)
        }
        .alert("Refresh Tasks & Events", isPresented: $showSoftResetConfirm) {
            Button("Refresh", role: .destructive) {
                Task {
                    dismiss()
                    await viewModel.softReset()
                }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This will clear all tasks, events, and conversation summaries, then re-analyze your recent messages. Your chat history will not be affected.")
        }
        .alert("Hard Reset", isPresented: $showHardResetConfirm) {
            Button("Reset", role: .destructive) {
                Task {
                    dismiss()
                    await viewModel.hardReset()
                }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This will wipe the local database and re-import everything from scratch. This may take several minutes.")
        }
    }

    private func apiKeySection(
        title: String,
        placeholder: String,
        input: Binding<String>,
        maskedKey: String?,
        helpText: String,
        onRemove: @escaping () -> Void
    ) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title)
                .font(.subheadline)
                .foregroundStyle(.secondary)

            SecureField(placeholder, text: input)
                .textFieldStyle(.roundedBorder)

            HStack {
                if let masked = maskedKey, input.wrappedValue.isEmpty {
                    Text("Current: \(masked)")
                        .font(.caption)
                        .foregroundStyle(.secondary)

                    Button("Remove") {
                        onRemove()
                    }
                    .font(.caption)
                    .foregroundStyle(AppColors.settingsDestructive)
                    .buttonStyle(.plain)
                }

                Spacer()

                Text(helpText)
                    .font(.caption)
                    .foregroundStyle(.tertiary)
            }
        }
    }

    private var modelPicker: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Models")
                .font(.subheadline)
                .foregroundStyle(.secondary)

            if availableModels.isEmpty {
                Text("Enter at least one API key to select models.")
                    .font(.caption)
                    .foregroundStyle(.tertiary)
            } else {
                HStack {
                    Text("Tasks & Events")
                        .font(.caption)
                        .frame(width: 120, alignment: .leading)
                    Picker("", selection: $actionsModel) {
                        ForEach(availableModels) { model in
                            Text(model.name).tag(model.id)
                        }
                    }
                    .labelsHidden()
                }

                HStack {
                    Text("Summaries")
                        .font(.caption)
                        .frame(width: 120, alignment: .leading)
                    Picker("", selection: $summaryModel) {
                        ForEach(availableModels) { model in
                            Text(model.name).tag(model.id)
                        }
                    }
                    .labelsHidden()
                }

                HStack {
                    Text("Ask Mode")
                        .font(.caption)
                        .frame(width: 120, alignment: .leading)
                    Picker("", selection: $askModel) {
                        ForEach(availableModels) { model in
                            Text(model.name).tag(model.id)
                        }
                    }
                    .labelsHidden()
                }
            }
        }
    }

    private func loadSettings() async {
        isLoading = true
        do {
            async let settingsReq = viewModel.fetchSettings()
            async let modelsReq = viewModel.fetchModels()
            let (settings, fetchedModels) = try await (settingsReq, modelsReq)

            // Show masked keys from Keychain (not from server)
            if let key = KeychainManager.anthropicApiKey {
                maskedAnthropicKey = maskKey(key)
            }
            if let key = KeychainManager.openaiApiKey {
                maskedOpenaiKey = maskKey(key)
            }
            models = fetchedModels
            let defaultSonnet = fetchedModels.first(where: { $0.available && $0.id.contains("sonnet") })?.id
            let defaultHaiku = fetchedModels.first(where: { $0.available && $0.id.contains("haiku") })?.id
            let defaultModel = fetchedModels.first(where: { $0.available })?.id ?? ""
            actionsModel = settings.actionsModel ?? settings.selectedModel ?? defaultSonnet ?? defaultModel
            summaryModel = settings.summaryModel ?? defaultHaiku ?? defaultModel
            askModel = settings.askModel ?? settings.selectedModel ?? defaultHaiku ?? defaultModel
        } catch {
            statusMessage = "Error loading settings"
        }
        isLoading = false
    }

    private func removeKey(provider: String) async {
        let key = provider == "anthropic" ? "anthropicApiKey" : "openaiApiKey"
        do {
            // Remove from Keychain
            if provider == "anthropic" {
                KeychainManager.anthropicApiKey = nil
            } else {
                KeychainManager.openaiApiKey = nil
            }
            // Tell server to clear the in-memory key
            try await viewModel.updateSettings([key: ""])
            if provider == "anthropic" {
                maskedAnthropicKey = nil
            } else {
                maskedOpenaiKey = nil
            }
            // Refresh models availability and reset any that lost their key
            if let fetchedModels = try? await viewModel.fetchModels() {
                models = fetchedModels
                let available = fetchedModels.filter { $0.available }
                let fallback = available.first?.id ?? ""
                if !available.contains(where: { $0.id == actionsModel }) { actionsModel = fallback }
                if !available.contains(where: { $0.id == summaryModel }) { summaryModel = fallback }
                if !available.contains(where: { $0.id == askModel }) { askModel = fallback }
            }
            viewModel.hasApiKey = (maskedAnthropicKey != nil || maskedOpenaiKey != nil)
            statusMessage = "\(provider == "anthropic" ? "Anthropic" : "OpenAI") key removed"
        } catch {
            statusMessage = "Error removing key"
        }
    }

    private func save() async {
        isSaving = true
        statusMessage = nil

        // Save API keys to Keychain
        if !anthropicKeyInput.isEmpty {
            KeychainManager.anthropicApiKey = anthropicKeyInput
        }
        if !openaiKeyInput.isEmpty {
            KeychainManager.openaiApiKey = openaiKeyInput
        }

        // Build server update — always push current Keychain keys so the server has them in memory
        var updates: [String: String] = [:]

        if !anthropicKeyInput.isEmpty {
            updates["anthropicApiKey"] = anthropicKeyInput
        }
        if !openaiKeyInput.isEmpty {
            updates["openaiApiKey"] = openaiKeyInput
        }
        if !actionsModel.isEmpty {
            updates["actionsModel"] = actionsModel
        }
        if !summaryModel.isEmpty {
            updates["summaryModel"] = summaryModel
        }
        if !askModel.isEmpty {
            updates["askModel"] = askModel
        }

        guard !updates.isEmpty else {
            isSaving = false
            dismiss()
            return
        }

        do {
            try await viewModel.updateSettings(updates)

            // Update masked displays
            if !anthropicKeyInput.isEmpty {
                maskedAnthropicKey = maskKey(anthropicKeyInput)
                anthropicKeyInput = ""
            }
            if !openaiKeyInput.isEmpty {
                maskedOpenaiKey = maskKey(openaiKeyInput)
                openaiKeyInput = ""
            }

            // Refresh models availability and reset any that lost their key
            if let fetchedModels = try? await viewModel.fetchModels() {
                models = fetchedModels
                let available = fetchedModels.filter { $0.available }
                let fallback = available.first?.id ?? ""
                if !available.contains(where: { $0.id == actionsModel }) { actionsModel = fallback }
                if !available.contains(where: { $0.id == summaryModel }) { summaryModel = fallback }
                if !available.contains(where: { $0.id == askModel }) { askModel = fallback }
            }

            viewModel.hasApiKey = (maskedAnthropicKey != nil || maskedOpenaiKey != nil)
            statusMessage = "Saved"
        } catch {
            statusMessage = "Error saving settings"
        }

        isSaving = false
    }

    private func maskKey(_ key: String) -> String {
        key.count > 12
            ? String(key.prefix(7)) + "..." + String(key.suffix(4))
            : "***"
    }
}
