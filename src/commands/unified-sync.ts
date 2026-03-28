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
  getAffectedChatIds,
} from '../etl/load.js';
import { extractLinkPreviewRows, transformLinkPreviews } from '../etl/link-preview.js';
import { buildContactMap, resolveHandle } from '../contacts/address-book.js';
import { embed } from './embed.js';
import { updateMetadata, refreshChatMetadata } from './update-metadata.js';
import type { LLMConfig } from '../llm/query-parser.js';
import { DATA_DIR } from '../config.js';
import { updateSyncProgress } from '../progress.js';

const PG_DATA_DIR = path.join(DATA_DIR, 'pgdata');
const SETTINGS_PATH = path.join(DATA_DIR, 'settings.json');

export interface UnifiedSyncOptions {
  /**
   * - 'hardReset': Wipe DB, import 90 days, embed all, metadata for 7-day window
   * - 'pullLatest': Import 7 days, embed new, metadata only for chats with new messages
   * - 'resync': Import 7 days, embed new, metadata for all chats in 7-day window
   */
  mode: 'hardReset' | 'pullLatest' | 'resync';
  /** Skip embedding step */
  skipEmbed?: boolean;
  /** Skip metadata/actions update */
  skipMetadata?: boolean;
  /** Number of days to look back for metadata (summaries + actions). Defaults to 7. */
  metadataDays?: number;
  /** Embedding batch size */
  embedBatchSize?: number;
  /** LLM config for metadata — if omitted, loads from settings.json */
  llmConfig?: LLMConfig;
}

export interface UnifiedSyncResult {
  messagesAdded: number;
  newMessageCount: number;
  affectedChatIds: number[];
  handlesAdded: number;
  lastSynced: string;
  mode: string;
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

interface ETLResult {
  messagesAdded: number;
  newMessageCount: number;
  affectedChatIds: Set<number>;
  handlesAdded: number;
}

/**
 * Core ETL: extract from SQLite, transform, and load into PGLite.
 * Returns which chats received genuinely new messages.
 */
async function runETL(afterDate?: Date, stageBase: number = 0): Promise<ETLResult> {
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
  const allNewMessageIds = new Set<number>();
  const batchGen = extractMessagesBatched(sqlite, 5000, afterDate);
  for (const rawBatch of batchGen) {
    const transformed = transformMessages(rawBatch);
    const { totalProcessed, newMessageIds } = await loadMessages(pg, transformed);
    totalMessages += totalProcessed;
    for (const id of newMessageIds) allNewMessageIds.add(id);
    updateSyncProgress('etl', `Imported ${totalMessages.toLocaleString()} messages...`, stageBase + 5);
    process.stdout.write(`  Loaded ${totalMessages} messages\r`);
  }
  console.log(`  Loaded ${totalMessages} messages total (${allNewMessageIds.size} new)`);

  // Join tables
  console.log('Syncing join tables...');
  const cmJoins = extractChatMessageJoins(sqlite, afterDate);
  await loadChatMessageJoins(pg, cmJoins);
  const chJoins = extractChatHandleJoins(sqlite);
  await loadChatHandleJoins(pg, chJoins);

  // Determine which chats got new messages
  const affectedChatIds = getAffectedChatIds(cmJoins, allNewMessageIds);

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
  return { messagesAdded: totalMessages, newMessageCount: allNewMessageIds.size, affectedChatIds, handlesAdded: handleCount };
}

export async function unifiedSync(options: UnifiedSyncOptions): Promise<UnifiedSyncResult> {
  const { mode, skipEmbed = false, skipMetadata = false, embedBatchSize = 200, metadataDays = 7 } = options;

  if (mode === 'hardReset') {
    return hardReset(options);
  }

  // --- pullLatest or resync ---
  updateSyncProgress('setup', 'Copying message database...', 0);
  console.log(`=== ${mode === 'resync' ? 'Resync' : 'Pull Latest'} ===`);
  await copyDb({ force: true });

  const pg = await getPglite();
  await initSchema();

  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  updateSyncProgress('etl', 'Importing messages...', 5);
  const etlResult = await runETL(sevenDaysAgo, 5);
  console.log(`  ${etlResult.affectedChatIds.size} conversation(s) have new messages.`);

  const now = new Date();
  await setLastSynced(pg, now);

  // Embed new messages (embed() already only processes messages with no embedding)
  if (!skipEmbed) {
    console.log('Embedding new messages...');
    updateSyncProgress('embedding', 'Generating embeddings...', 50);
    await embed({ batchSize: embedBatchSize });
  }

  // Metadata
  if (!skipMetadata) {
    const llmConfig = getLLMConfig(options);
    const metadataCutoff = new Date(Date.now() - metadataDays * 24 * 60 * 60 * 1000);

    if (mode === 'resync') {
      // Resync: update metadata for ALL conversations in the time window
      console.log(`Updating metadata for all conversations (last ${metadataDays}d)...`);
      updateSyncProgress('metadata', 'Generating conversation summaries...', 85);
      await updateMetadata(llmConfig, { since: metadataCutoff, minMessages: 1 });
    } else {
      // Pull latest: metadata for conversations with new messages + any missing metadata
      console.log(`Updating metadata (${etlResult.affectedChatIds.size} conversation(s) with new messages + any missing)...`);
      updateSyncProgress('metadata', 'Generating conversation summaries...', 85);
      await updateMetadata(llmConfig, {
        since: metadataCutoff,
        minMessages: 1,
        chatIds: etlResult.affectedChatIds,
      });
    }
  }

  updateSyncProgress('done', 'Complete!', 100);
  console.log('\nSync complete!');
  return {
    messagesAdded: etlResult.messagesAdded,
    newMessageCount: etlResult.newMessageCount,
    affectedChatIds: [...etlResult.affectedChatIds],
    handlesAdded: etlResult.handlesAdded,
    lastSynced: now.toISOString(),
    mode,
  };
}

async function hardReset(options: UnifiedSyncOptions): Promise<UnifiedSyncResult> {
  const { skipEmbed = false, skipMetadata = false, embedBatchSize = 200, metadataDays = 7 } = options;

  console.log('=== Hard Reset ===');
  updateSyncProgress('setup', 'Preparing database...', 0);

  // Wipe pgdata — close PGLite first, wait for it to release file locks
  console.log('Closing PGLite...');
  await closePglite();
  await new Promise((r) => setTimeout(r, 500));

  if (fs.existsSync(PG_DATA_DIR)) {
    console.log('Wiping PGLite database...');
    fs.rmSync(PG_DATA_DIR, { recursive: true, force: true });
  }

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

  // Init fresh PGLite
  const pg = await getPglite();
  await initSchema();

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
  if (!skipMetadata) {
    const llmConfig = getLLMConfig(options);
    const metadataCutoff = new Date(Date.now() - metadataDays * 24 * 60 * 60 * 1000);
    console.log(`\nUpdating chat metadata (last ${metadataDays}d)...`);
    updateSyncProgress('metadata', 'Generating conversation summaries...', 85);
    await updateMetadata(llmConfig, { since: metadataCutoff, minMessages: 1 });
  }

  const now = new Date();
  await setLastSynced(pg, now);

  updateSyncProgress('done', 'Complete!', 100);
  console.log('\nHard reset complete!');
  return {
    messagesAdded: etlResult.messagesAdded,
    newMessageCount: etlResult.newMessageCount,
    affectedChatIds: [...etlResult.affectedChatIds],
    handlesAdded: etlResult.handlesAdded,
    lastSynced: now.toISOString(),
    mode: 'hardReset',
  };
}

/**
 * Sync a single conversation: pull new messages, embed, refresh metadata.
 */
export async function syncSingleConversation(chatId: number, llmConfig: LLMConfig): Promise<{ newMessages: number }> {
  // Copy fresh chat.db
  await copyDb({ force: true });

  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const sqlite = openSqlite();
  verifySqliteTables(sqlite);
  const pg = await getPglite();

  // Get message IDs for this chat from SQLite
  const cmJoins = extractChatMessageJoins(sqlite, sevenDaysAgo);
  const chatMessageIds = new Set(cmJoins.filter((j) => j.chat_id === chatId).map((j) => j.message_id));

  // Extract, transform, and load only those messages
  let newCount = 0;
  const batchGen = extractMessagesBatched(sqlite, 5000, sevenDaysAgo);
  for (const rawBatch of batchGen) {
    const filtered = rawBatch.filter((m) => chatMessageIds.has(m.id));
    if (filtered.length === 0) continue;
    const transformed = transformMessages(filtered);
    const { newMessageIds } = await loadMessages(pg, transformed);
    newCount += newMessageIds.size;
  }

  // Load the joins for this chat
  const relevantJoins = cmJoins.filter((j) => j.chat_id === chatId);
  await loadChatMessageJoins(pg, relevantJoins);

  await populateTextSearch(pg);
  sqlite.close();

  // Embed any new messages
  await embed({ batchSize: 200 });

  // Refresh metadata for just this chat
  await refreshChatMetadata(chatId, llmConfig);

  console.log(`[sync] Chat ${chatId}: ${newCount} new message(s), metadata refreshed.`);
  return { newMessages: newCount };
}
