// Shared sync progress tracking — imported by sync pipeline modules,
// read by the server's /health endpoint.

export interface SyncProgress {
  stage: string;
  detail: string;
  percent: number; // 0-100 overall progress
}

let syncProgress: SyncProgress = { stage: 'idle', detail: '', percent: 0 };

export function updateSyncProgress(stage: string, detail: string, percent: number) {
  syncProgress = { stage, detail, percent: Math.min(100, Math.max(0, percent)) };
}

export function getSyncProgress(): SyncProgress {
  return syncProgress;
}

// Background embedding progress — runs independently of the main sync pipeline.
// Exposed via /health so the frontend can show an indexing indicator.

export interface EmbeddingProgress {
  isRunning: boolean;
  total: number;
  processed: number;
}

let embeddingProgress: EmbeddingProgress = { isRunning: false, total: 0, processed: 0 };

export function updateEmbeddingProgress(update: Partial<EmbeddingProgress>) {
  embeddingProgress = { ...embeddingProgress, ...update };
}

export function getEmbeddingProgress(): EmbeddingProgress {
  return embeddingProgress;
}
