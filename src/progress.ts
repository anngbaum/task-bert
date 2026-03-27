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
