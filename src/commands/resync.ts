import { unifiedSync } from './unified-sync.js';

export interface ResyncOptions {
  metadataOnly?: boolean;
  batchSize?: number;
  short?: boolean;
}

export async function resync(options: ResyncOptions = {}): Promise<void> {
  // Check if server is running — warn user to stop it to avoid PGLite conflicts
  try {
    await fetch('http://localhost:11488/api/settings');
    console.warn('\nWarning: Server is running. Stop it before resync to avoid DB conflicts.');
    console.warn('  Run: kill $(lsof -ti :11488) && npm run resync\n');
  } catch {
    // Server not running — good
  }

  if (options.metadataOnly) {
    // Just pull latest + update metadata for all conversations
    await unifiedSync({ mode: 'resync', skipEmbed: true, embedBatchSize: options.batchSize ?? 200 });
  } else {
    // Full hard reset
    await unifiedSync({ mode: 'hardReset', embedBatchSize: options.batchSize ?? 200 });
  }

  console.log('\nResync complete!');
}
