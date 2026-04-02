import SwiftUI

struct TaskTriageView: View {
    @ObservedObject var viewModel: SearchViewModel
    let onComplete: () -> Void
    @State private var isTargetedUpcoming = false
    @State private var pendingMoveTaskId: Int? = nil
    @State private var upcomingDate: Date = Date().addingTimeInterval(7 * 24 * 60 * 60)
    @State private var movedToUpcoming: [(id: Int, title: String)] = []

    private var todoTasks: [TaskItem] {
        viewModel.tasks.filter { $0.resolvedBucket == "todo" }
    }

    private var isLoading: Bool {
        viewModel.isSyncing || viewModel.isLoadingActions
    }

    var body: some View {
        VStack(spacing: 0) {
            if isLoading {
                // Full-screen loading while sync + extraction runs
                VStack(spacing: 20) {
                    Spacer()

                    Image("Broom")
                        .resizable()
                        .aspectRatio(contentMode: .fit)
                        .frame(width: 100, height: 100)

                    Text("Hello, I'm Bert.")
                        .font(.title)
                        .fontWeight(.semibold)

                    Text(viewModel.lastSyncMessage ?? "Syncing your messages...")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, 60)

                    ProgressView()
                        .padding(.top, 4)

                    Spacer()
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if todoTasks.isEmpty && movedToUpcoming.isEmpty {
                VStack(spacing: 12) {
                    Image(systemName: "checkmark.circle")
                        .font(.system(size: 48))
                        .foregroundStyle(AppColors.triageSuccess)
                    Text("No tasks yet")
                        .font(.title3)
                        .foregroundStyle(.secondary)
                    Text("Tasks will appear here after your first sync.")
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                // Header
                VStack(spacing: 8) {
                    Image(systemName: "checklist")
                        .font(.system(size: 36))
                        .foregroundStyle(AppColors.triageHeader)

                    Text("Review Your To-Dos")
                        .font(.title2)
                        .fontWeight(.semibold)

                    Text("These should be things you can tackle now. Check off anything that's already done or no longer relevant by clicking the circle, and drag items to Upcoming if you'd rather handle them later.")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, 60)
                }
                .padding(.top, 24)
                .padding(.bottom, 16)

                Divider()

                // Task list
                ScrollView {
                    VStack(alignment: .leading, spacing: 6) {
                        if !todoTasks.isEmpty {
                            Text("To Do")
                                .font(.caption)
                                .fontWeight(.semibold)
                                .foregroundStyle(.secondary)
                                .padding(.horizontal, 4)

                            ForEach(todoTasks) { task in
                                TaskRowView(
                                    task: task,
                                    accentColor: AppColors.taskUpcoming,
                                    onComplete: { await viewModel.completeTask(id: task.id) },
                                    onTap: nil,
                                    onTogglePriority: nil
                                )
                                .draggable("task:\(task.id)")
                            }
                        }

                        if todoTasks.isEmpty {
                            HStack {
                                Spacer()
                                VStack(spacing: 4) {
                                    Image(systemName: "checkmark.circle")
                                        .font(.system(size: 24))
                                        .foregroundStyle(AppColors.triageSuccess)
                                    Text("All caught up!")
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                                Spacer()
                            }
                            .padding(.vertical, 20)
                        }

                        // Moved to upcoming (shown if any were moved during this triage)
                        if !movedToUpcoming.isEmpty {
                            Text("Moved to Upcoming")
                                .font(.caption)
                                .fontWeight(.semibold)
                                .foregroundStyle(AppColors.eventAccent)
                                .padding(.horizontal, 4)
                                .padding(.top, 8)

                            ForEach(movedToUpcoming, id: \.id) { item in
                                HStack(spacing: 8) {
                                    Image(systemName: "calendar.badge.clock")
                                        .font(.caption)
                                        .foregroundStyle(AppColors.eventAccent)
                                    Text(item.title)
                                        .font(.caption)
                                        .lineLimit(1)
                                    Spacer()
                                }
                                .padding(.vertical, 4)
                                .padding(.horizontal, 6)
                                .background(AppColors.eventAccentBackground)
                                .cornerRadius(6)
                            }
                        }
                    }
                    .padding(.horizontal, 16)
                    .padding(.vertical, 12)
                }

                Divider()

                // Upcoming drop zone
                VStack(spacing: 6) {
                    HStack(spacing: 6) {
                        Image(systemName: "calendar.badge.clock")
                            .font(.caption)
                        Text("Drag here to move to Upcoming")
                            .font(.caption)
                    }
                    .foregroundStyle(isTargetedUpcoming ? AppColors.eventAccent : .secondary)
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 14)
                .background(
                    RoundedRectangle(cornerRadius: 8)
                        .fill(isTargetedUpcoming ? AppColors.eventDropZoneTargeted : AppColors.eventDropZone)
                )
                .overlay(
                    RoundedRectangle(cornerRadius: 8)
                        .stroke(
                            isTargetedUpcoming ? AppColors.eventDropZoneBorderTargeted : AppColors.eventDropZoneBorder,
                            style: StrokeStyle(lineWidth: 1.5, dash: [6, 4])
                        )
                )
                .padding(.horizontal, 16)
                .padding(.vertical, 8)
                .dropDestination(for: String.self) { items, _ in
                    guard let item = items.first, item.hasPrefix("task:"),
                          let taskId = Int(item.dropFirst(5)) else { return false }
                    if viewModel.tasks.first(where: { $0.id == taskId })?.resolvedBucket == "upcoming" { return false }
                    upcomingDate = Date().addingTimeInterval(7 * 24 * 60 * 60)
                    pendingMoveTaskId = taskId
                    return true
                } isTargeted: { targeted in
                    withAnimation(.easeInOut(duration: 0.15)) {
                        isTargetedUpcoming = targeted
                    }
                }
            }

            // Done button (hidden while loading)
            if !isLoading {
                Button(action: onComplete) {
                    Text("Done")
                        .fontWeight(.medium)
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .padding(.horizontal, 16)
                .padding(.bottom, 16)
                .padding(.top, 8)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .onAppear {
            Task {
                await viewModel.loadActions()
            }
        }
        .sheet(item: $pendingMoveTaskId) { taskId in
            UpcomingDatePickerSheet(
                date: $upcomingDate,
                taskTitle: viewModel.tasks.first(where: { $0.id == taskId })?.title ?? "Task",
                onConfirm: {
                    let date = upcomingDate
                    let title = viewModel.tasks.first(where: { $0.id == taskId })?.title ?? "Task"
                    movedToUpcoming.append((id: taskId, title: title))
                    pendingMoveTaskId = nil
                    Task { await viewModel.moveTask(id: taskId, toBucket: "upcoming", date: date) }
                },
                onCancel: {
                    pendingMoveTaskId = nil
                }
            )
        }
    }
}
