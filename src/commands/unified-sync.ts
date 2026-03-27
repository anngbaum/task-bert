import fs from 'fs';
import path from 'path';
import { openSqlite, verifySqliteTables } from '../db/sqlite-reader.js';
import { getPglite, closePglite, initSchema } from '../db/pglite-client.js';
import { copyDb } from './copy-db.js';
import {
  extractHandles,
  extractChats,
  extractMessagesBatched,
  extractChatMessageJoins,
  extractChatHandleJoins,
} from '../etl/extract.js';
import { transformMessages } from '../etl/transform.js';
import {
  loadHandles,
  loadChats,
  loadMessages,
  loadChatMessageJoins,
  loadChatHandleJoins,
  loadLinkPreviews,
  populateTextSearch,
} from '../etl/load.js';
import { extractLinkPreviewRows, transformLinkPreviews } from '../etl/link-preview.js';
import { buildContactMap, resolveHandle } from '../contacts/address-book.js';
import { embed } from './embed.js';
import { updateMetadata } from './update-metadata.js';
import type { LLMConfig } from '../llm/query-parser.js';
import { DATA_DIR } from '../config.js';
import { updateSyncProgress } from '../progress.js';

const PG_DATA_DIR = path.join(DATA_DIR, 'pgdata');
const SETTINGS_PATH = path.join(DATA_DIR, 'settings.json');

export interface UnifiedSyncOptions {
  /** Wipe pgdata and do a full re-ingest + embed + metadata from scratch */
  hardReset?: boolean;
  /** Skip embedding step */
  skipEmbed?: boolean;
  /** Skip metadata/actions update */
  skipMetadata?: boolean;
  /** Use full metadata windows instead of incremental since-last-update */
  fullMetadataRefresh?: boolean;
  /** Number of days to look back for metadata (summaries + actions). Defaults to 7. */
  metadataDays?: number;
  /** Embedding batch size */
  embedBatchSize?: number;
  /** LLM config for metadata — if omitted, loads from settings.json */
  llmConfig?: LLMConfig;
}

export interface UnifiedSyncResult {
  messagesAdded: number;
  handlesAdded: number;
  lastSynced: string;
  wasHardReset: boolean;
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

function loadSettings(): { anthropicApiKey?: string; openaiApiKey?: string; selectedModel?: string } {
  try {
    if (fs.existsSync(SETTINGS_PATH)) {
      return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8'));
    }
  } catch { /* ignore */ }
  return {};
}

function getLLMConfig(options: UnifiedSyncOptions): LLMConfig {
  if (options.llmConfig) return options.llmConfig;
  const s = loadSettings();
  return {
    model: s.selectedModel ?? 'claude-haiku-4-5-20251001',
    anthropicApiKey: s.anthropicApiKey,
    openaiApiKey: s.openaiApiKey,
  };
}

export async function getLastSynced(pg: import('@electric-sql/pglite').PGlite): Promise<Date | null> {
  const result = await pg.query('SELECT last_synced FROM sync_meta WHERE id = 1');
  if (result.rows.length === 0) return null;
  return new Date((result.rows[0] as { last_synced: string }).last_synced);
}

async function setLastSynced(pg: import('@electric-sql/pglite').PGlite, date: Date): Promise<void> {
  await pg.query(
    `INSERT INTO sync_meta (id, last_synced) VALUES (1, $1)
     ON CONFLICT (id) DO UPDATE SET last_synced = $1`,
    [date.toISOString()]
  );
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
       VALUES ($1, $2, $3, $4, NULL, $5, $6)`,
      [f.chat_id, f.message_id, f.title, f.date, f.completed, f.created_at]
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

/**
 * Core ETL: extract from SQLite, transform, and load into PGLite.
 * Used by both incremental sync and hard reset.
 */
async function runETL(afterDate?: Date, stageBase: number = 0): Promise<{ messagesAdded: number; handlesAdded: number }> {
  const sqlite = openSqlite();
  verifySqliteTables(sqlite);
  const pg = await getPglite();

  // Handles (with contact resolution)
  console.log('Syncing handles...');
  updateSyncProgress('etl', 'Syncing contacts...', stageBase);
  const contactMap = await buildContactMap();
  const handles = extractHandles(sqlite);
  let resolvedCount = 0;
  for (const handle of handles) {
    const displayName = resolveHandle(handle.identifier, contactMap);
    handle.display_name = displayName;
    if (displayName) resolvedCount++;
  }
  const handleCount = await loadHandles(pg, handles);
  console.log(`  Loaded ${handleCount} handles (${resolvedCount} with contact names)`);

  // Chats
  console.log('Syncing chats...');
  updateSyncProgress('etl', 'Importing conversations...', stageBase + 2);
  const chats = extractChats(sqlite);
  await loadChats(pg, chats);

  // Messages
  const dateLabel = afterDate
    ? `since ${afterDate.toISOString().split('T')[0]}`
    : '(all messages)';
  console.log(`Extracting messages ${dateLabel}...`);
  updateSyncProgress('etl', 'Importing messages...', stageBase + 5);
  let totalMessages = 0;
  const batchGen = extractMessagesBatched(sqlite, 5000, afterDate);
  for (const rawBatch of batchGen) {
    const transformed = transformMessages(rawBatch);
    const loaded = await loadMessages(pg, transformed);
    totalMessages += loaded;
    updateSyncProgress('etl', `Imported ${totalMessages.toLocaleString()} messages...`, stageBase + 5);
    process.stdout.write(`  Loaded ${totalMessages} messages\r`);
  }
  console.log(`  Loaded ${totalMessages} messages total`);

  // Join tables
  console.log('Syncing join tables...');
  const cmJoins = extractChatMessageJoins(sqlite, afterDate);
  await loadChatMessageJoins(pg, cmJoins);
  const chJoins = extractChatHandleJoins(sqlite);
  await loadChatHandleJoins(pg, chJoins);

  // Link previews
  console.log('Extracting link previews...');
  const linkRows = extractLinkPreviewRows(sqlite, afterDate);
  const linkPreviews = transformLinkPreviews(linkRows);
  const linkCount = await loadLinkPreviews(pg, linkPreviews);
  console.log(`  Loaded ${linkCount} link previews`);

  // Full-text search
  console.log('Updating text search index...');
  updateSyncProgress('etl', 'Building search index...', stageBase + 15);
  const ftsCount = await populateTextSearch(pg);
  console.log(`  Indexed ${ftsCount} messages for full-text search`);

  sqlite.close();
  return { messagesAdded: totalMessages, handlesAdded: handleCount };
}

export async function unifiedSync(options: UnifiedSyncOptions = {}): Promise<UnifiedSyncResult> {
  const { hardReset = false, skipEmbed = false, skipMetadata = false, fullMetadataRefresh = false, embedBatchSize = 200, metadataDays = 7 } = options;

  if (hardReset) {
    // --- Hard reset: wipe and rebuild from scratch ---
    console.log('=== Hard Reset ===');
    updateSyncProgress('setup', 'Preparing database...', 0);

    // Wipe pgdata — close PGLite first, wait for it to release file locks
    console.log('Closing PGLite...');
    await closePglite();
    // Brief pause to let file handles release
    await new Promise((r) => setTimeout(r, 500));

    if (fs.existsSync(PG_DATA_DIR)) {
      console.log('Wiping PGLite database...');
      fs.rmSync(PG_DATA_DIR, { recursive: true, force: true });
    }

    // Verify the directory is actually gone
    if (fs.existsSync(PG_DATA_DIR)) {
      console.error('[hard-reset] WARNING: pgdata directory still exists after wipe, retrying...');
      await new Promise((r) => setTimeout(r, 1000));
      fs.rmSync(PG_DATA_DIR, { recursive: true, force: true });
    }

    console.log(`[hard-reset] pgdata wiped: ${!fs.existsSync(PG_DATA_DIR)}`);

    // Copy fresh chat.db
    console.log('Copying fresh chat.db...');
    updateSyncProgress('setup', 'Copying message database...', 2);
    await copyDb({ force: true });

    // Init fresh PGLite — this creates a brand new database
    const pg = await getPglite();
    await initSchema();

    // Verify fresh state
    const msgCount = await pg.query('SELECT count(*) as cnt FROM message');
    console.log(`[hard-reset] Fresh DB message count: ${(msgCount.rows[0] as any).cnt}`);

    // Ingest last 90 days of messages
    const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    updateSyncProgress('etl', 'Importing messages...', 5);
    const etlResult = await runETL(ninetyDaysAgo, 5);

    // Embed all
    if (!skipEmbed) {
      console.log('\nEmbedding messages...');
      updateSyncProgress('embedding', 'Generating embeddings...', 25);
      await embed({ batchSize: embedBatchSize });
    }

    // Update metadata for recent conversations
    // Summaries: last 14 days; Actions: last 30 days
    if (!skipMetadata) {
      const llmConfig = getLLMConfig(options);
      const metadataCutoff = new Date(Date.now() - metadataDays * 24 * 60 * 60 * 1000);
      console.log(`\nUpdating chat metadata (summaries: ${metadataDays}d, actions: ${metadataDays}d)...`);
      updateSyncProgress('metadata', 'Generating conversation summaries...', 85);
      await updateMetadata(llmConfig, { since: metadataCutoff, minMessages: 2, actionsSince: metadataCutoff });
    }

    const now = new Date();
    await setLastSynced(pg, now);

    updateSyncProgress('done', 'Complete!', 100);
    console.log('\nHard reset complete!');
    return {
      messagesAdded: etlResult.messagesAdded,
      handlesAdded: etlResult.handlesAdded,
      lastSynced: now.toISOString(),
      wasHardReset: true,
    };
  }

  // --- Incremental sync ---
  updateSyncProgress('setup', 'Copying message database...', 0);
  console.log('Copying fresh chat.db...');
  await copyDb({ force: true });

  const pg = await getPglite();
  await initSchema();

  const lastSynced = await getLastSynced(pg);
  const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
  const isFirstSync = !lastSynced;

  // Check if we already have 90 days of message coverage
  let afterDate: Date;
  if (isFirstSync) {
    afterDate = ninetyDaysAgo;
    console.log('No previous sync — importing last 90 days');
  } else {
    const oldestResult = await pg.query('SELECT MIN(date) as oldest FROM message WHERE date IS NOT NULL');
    const oldestDate = oldestResult.rows.length > 0 && (oldestResult.rows[0] as any).oldest
      ? new Date((oldestResult.rows[0] as any).oldest)
      : null;

    if (oldestDate && oldestDate <= ninetyDaysAgo) {
      // Already have 90-day coverage — just sync since last update
      afterDate = lastSynced!;
      console.log(`Last synced: ${lastSynced!.toISOString()} — 90-day coverage OK`);
    } else {
      // Gap detected — backfill to 90 days
      afterDate = ninetyDaysAgo;
      console.log(`Last synced: ${lastSynced!.toISOString()} — backfilling to 90 days`);
    }
  }

  updateSyncProgress('etl', 'Importing messages...', 5);
  const etlResult = await runETL(afterDate, 5);

  const now = new Date();
  await setLastSynced(pg, now);

  // Embed new messages
  if (!skipEmbed) {
    console.log('Embedding new messages...');
    updateSyncProgress('embedding', 'Generating embeddings...', isFirstSync ? 25 : 50);
    await embed({ batchSize: embedBatchSize });
  }

  // Metadata: incremental (since last update) by default,
  // full 14d/30d window on startup or explicit resync.
  if (!skipMetadata) {
    const llmConfig = getLLMConfig(options);
    if (fullMetadataRefresh) {
      const metadataCutoff = new Date(Date.now() - metadataDays * 24 * 60 * 60 * 1000);
      const metadataSince = afterDate < metadataCutoff ? afterDate : metadataCutoff;
      console.log(`Updating metadata (full refresh — summaries: ${metadataDays}d, actions: ${metadataDays}d)...`);
      updateSyncProgress('metadata', 'Generating conversation summaries...', 85);
      await updateMetadata(llmConfig, { since: metadataSince, minMessages: 1, actionsSince: metadataCutoff });
    } else {
      console.log('Updating metadata (incremental — since last update)...');
      updateSyncProgress('metadata', 'Generating conversation summaries...', 85);
      await updateMetadata(llmConfig, { minMessages: 1 });
    }
  }

  updateSyncProgress('done', 'Complete!', 100);
  console.log('\nSync complete!');
  return {
    messagesAdded: etlResult.messagesAdded,
    handlesAdded: etlResult.handlesAdded,
    lastSynced: now.toISOString(),
    wasHardReset: false,
  };
}
