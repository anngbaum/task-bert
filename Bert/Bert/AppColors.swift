import SwiftUI

/// Centralized color definitions for the app.
/// All semantic colors are defined here for easy theming and dark mode support.
enum AppColors {

    // MARK: - Events

    static let eventAccent = Color.purple
    static let eventAccentBackground = Color.purple.opacity(0.05)
    static let eventDropZone = Color.purple.opacity(0.04)
    static let eventDropZoneTargeted = Color.purple.opacity(0.12)
    static let eventDropZoneBorder = Color.purple.opacity(0.15)
    static let eventDropZoneBorderTargeted = Color.purple.opacity(0.4)

    // MARK: - Tasks

    static let taskTodo = Color.green
    static let taskUpcoming = Color.orange
    static let taskWaiting = Color.secondary
    static let taskCompleted = Color.green.opacity(0.5)
    static let taskDone = Color.green

    // MARK: - Status

    static let success = Color.green
    static let error = Color.red
    static let warning = Color.orange
    static let errorMuted = Color.red.opacity(0.6)

    // MARK: - Messages

    static let messageSent = Color.blue
    static let messageReceived = Color.secondary
    static let messageHighlight = Color.yellow.opacity(0.45)
    static let messageAnchor = Color.yellow.opacity(0.3)

    // MARK: - Agent Steps

    static let agentThinking = Color.purple
    static let agentToolCall = Color.blue
    static let agentToolResult = Color.green

    // MARK: - Surfaces

    static let cardBackground = Color.primary.opacity(0.03)
    static let subtleBackground = Color.primary.opacity(0.02)
    static let buttonBackground = Color.primary.opacity(0.05)
    static let dividerStroke = Color.primary.opacity(0.1)
    static let typeaheadSelection = Color.accentColor.opacity(0.15)
    static let noResultsBackground = Color.orange.opacity(0.08)
    static let bannerBackground = Color.secondary.opacity(0.06)

    // MARK: - Badges

    static let badgeConversations = Color.blue
    static let badgeActions = Color.green
    static let badgeEvents = Color.purple

    // MARK: - Links

    static let link = Color.blue

    // MARK: - Calendar Providers

    static let appleCalendar = Color.red
    static let googleCalendar = Color.blue

    // MARK: - Log Levels

    static let logError = Color.red
    static let logWarning = Color.orange

    // MARK: - Interactive

    static let syncBanner = Color.accentColor.opacity(0.08)
    static let selectedTab = Color.accentColor.opacity(0.15)
    static let filterSelected = Color.accentColor.opacity(0.2)
    static let filterChip = Color.accentColor.opacity(0.15)
    static let importButton = Color.accentColor.opacity(0.1)

    // MARK: - Shadows

    static let dropShadow = Color.black.opacity(0.15)

    // MARK: - Settings

    static let settingsRefresh = Color.orange
    static let settingsDestructive = Color.red
    static let settingsSync = Color.blue

    // MARK: - Triage

    static let triageHeader = Color.orange
    static let triageSuccess = Color.green
}
