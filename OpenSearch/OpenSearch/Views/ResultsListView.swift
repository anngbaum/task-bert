import SwiftUI

struct ResultsListView: View {
    @ObservedObject var viewModel: SearchViewModel

    var body: some View {
        Group {
            if viewModel.isSearching {
                VStack(spacing: 12) {
                    ProgressView()
                    Text("Searching...")
                        .foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let error = viewModel.errorMessage {
                VStack(spacing: 12) {
                    Image(systemName: "exclamationmark.triangle")
                        .font(.largeTitle)
                        .foregroundStyle(.orange)
                    Text(error)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .padding()
            } else if viewModel.hasSearched && viewModel.results.isEmpty {
                VStack(spacing: 12) {
                    Image(systemName: "magnifyingglass")
                        .font(.largeTitle)
                        .foregroundStyle(.secondary)
                    Text("No results found")
                        .foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if !viewModel.hasSearched {
                VStack(spacing: 12) {
                    Image(systemName: "message")
                        .font(.system(size: 48))
                        .foregroundStyle(.tertiary)
                    Text("Search your messages")
                        .font(.title3)
                        .foregroundStyle(.secondary)
                    Text("Enter a query above to get started")
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                VStack(spacing: 0) {
                    HStack {
                        Text("\(viewModel.results.count)\(viewModel.hasMore ? "+" : "") result\(viewModel.results.count == 1 ? "" : "s")")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        Spacer()
                    }
                    .padding(.horizontal)
                    .padding(.vertical, 6)

                    List {
                        ForEach(viewModel.results) { result in
                            VStack(alignment: .leading, spacing: 0) {
                                ResultRowView(result: result)
                                    .contentShape(Rectangle())
                                    .onTapGesture {
                                        Task { await viewModel.toggleContext(for: result) }
                                    }

                                if viewModel.expandedResults.contains(result.id) {
                                    ContextMessagesView(
                                        result: result,
                                        messages: viewModel.contextMessages[result.id],
                                        isLoading: viewModel.loadingContext.contains(result.id)
                                    )
                                    .padding(.top, 6)
                                }
                            }
                        }

                        if viewModel.hasMore {
                            HStack {
                                Spacer()
                                if viewModel.isLoadingMore {
                                    ProgressView()
                                        .controlSize(.small)
                                } else {
                                    Button("Show More") {
                                        Task { await viewModel.loadMore() }
                                    }
                                    .buttonStyle(.bordered)
                                }
                                Spacer()
                            }
                            .padding(.vertical, 8)
                        }
                    }
                }
            }
        }
    }
}
