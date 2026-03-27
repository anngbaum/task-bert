import fs from 'fs';
import path from 'path';
import { copyDb } from './copy-db.js';
import { ingest } from './ingest.js';
import { embed } from './embed.js';
import { updateMetadata } from './update-metadata.js';
import { getPglite, closePglite, initSchema } from '../db/pglite-client.js';
import { DATA_DIR } from '../config.js';

const PG_DATA_DIR = path.join(DATA_DIR, 'pgdata');
const SETTINGS_PATH = path.join(DATA_DIR, 'settings.json');

function loadSettings(): { anthropicApiKey?: string; openaiApiKey?: string; selectedModel?: string } {
  try {
    if (fs.existsSync(SETTINGS_PATH)) {
      return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8'));
    }
  } catch { /* ignore */ }
  return {};
}

export interface ResyncOptions {
  metadataOnly?: boolean;
  batchSize?: number;
  short?: boolean;
}

interface SavedFollowUp {
  chat_id: number;
  message_id: number | null;
  title: string;
  date: string | null;
  key_event_id: number | null;
  completed: boolean;
  created_at: string;
}

interface SavedActionItem {
  chat_id: number;
  message_id: number;
  title: string;
  date: string | null;
  completed: boolean;
  created_at: string;
}

async function backupCompletedItems(): Promise<{ followUps: SavedFollowUp[]; actionItems: SavedActionItem[] }> {
  try {
    const db = await getPglite();
    const followUps = await db.query(
      'SELECT chat_id, message_id, title, date, key_event_id, completed, created_at FROM suggested_follow_ups WHERE completed = true'
    );
    const actionItems = await db.query(
      'SELECT chat_id, message_id, title, date, completed, created_at FROM action_items WHERE completed = true'
    );
    return {
      followUps: followUps.rows as SavedFollowUp[],
      actionItems: actionItems.rows as SavedActionItem[],
    };
  } catch {
    return { followUps: [], actionItems: [] };
  }
}

async function restoreCompletedItems(items: { followUps: SavedFollowUp[]; actionItems: SavedActionItem[] }): Promise<void> {
  const db = await getPglite();
  for (const f of items.followUps) {
    await db.query(
      `INSERT INTO suggested_follow_ups (chat_id, message_id, title, date, key_event_id, completed, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [f.chat_id, f.message_id, f.title, f.date, f.key_event_id, f.completed, f.created_at]
    );
  }
  for (const a of items.actionItems) {
    await db.query(
      `INSERT INTO action_items (chat_id, message_id, title, date, completed, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [a.chat_id, a.message_id, a.title, a.date, a.completed, a.created_at]
    );
  }
  const total = items.followUps.length + items.actionItems.length;
  if (total > 0) console.log(`  Restored ${total} completed item(s).`);
}

export async function resync(options: ResyncOptions = {}): Promise<void> {
  if (!options.metadataOnly) {
    // 0. Back up completed items before wiping
    const completedItems = await backupCompletedItems();

    // 1. Wipe PGLite data (not the source chat.db)
    if (fs.existsSync(PG_DATA_DIR)) {
      console.log('Wiping local PGLite database...');
      fs.rmSync(PG_DATA_DIR, { recursive: true, force: true });
      console.log('  Done.');
    }

    // Reset the cached PGLite client since we just deleted its data
    await closePglite();

    // 2. Copy fresh chat.db
    console.log('Copying fresh chat.db...');
    await copyDb({ force: true });

    // 3. Ingest messages
    const months = options.short ? 0.25 : 6;
    const label = options.short ? '1 week' : '6 months';
    console.log(`Ingesting last ${label} of messages...`);
    await ingest({ months });

    // 4. Restore completed items so they aren't recreated
    await restoreCompletedItems(completedItems);

    // 5. Embed all messages
    console.log('\nStarting embedding...');
    await embed({ batchSize: options.batchSize ?? 200 });
  }

  // 5. Summarize chats active in the last 14 days (with >1 message)
  // Check if server is running — warn user to stop it to avoid PGLite conflicts
  try {
    await fetch('http://localhost:11488/api/settings');
    console.warn('\nWarning: Server is running. Stop it before resync to avoid DB conflicts.');
    console.warn('  Run: kill $(lsof -ti :11488) && npm run resync -- --metadata-only\n');
  } catch {
    // Server not running — good
  }

  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  console.log('\nUpdating chat metadata for recent conversations...');
  const settings = loadSettings();
  const llmConfig = {
    model: settings.selectedModel ?? 'claude-haiku-4-5-20251001',
    anthropicApiKey: settings.anthropicApiKey,
    openaiApiKey: settings.openaiApiKey,
  };
  await updateMetadata(llmConfig, { since: sevenDaysAgo, minMessages: 2, actionsSince: sevenDaysAgo });

  console.log('\nResync complete!');
}
