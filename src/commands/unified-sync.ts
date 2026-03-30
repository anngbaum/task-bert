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
  extractAttachments,
  extractMessageAttachmentJoins,
} from '../etl/extract.js';
import { transformMessages } from '../etl/transform.js';
import {
  loadHandles,
  loadChats,
  loadMessages,
  loadChatMessageJoins,
  loadChatHandleJoins,
  loadLinkPreviews,
  loadAttachments,
  loadMessageAttachmentJoins,
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
   * - 'hardReset': Wipe DB, import 120 days, embed all, metadata for 7-day window
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

  // Attachments
  console.log('Syncing attachments...');
  const attachments = extractAttachments(sqlite);
  const attachmentCount = await loadAttachments(pg, attachments);
  console.log(`  Loaded ${attachmentCount} attachments`);
  const maJoins = extractMessageAttachmentJoins(sqlite, afterDate);
  await loadMessageAttachmentJoins(pg, maJoins);
  console.log(`  Loaded ${maJoins.length} message-attachment joins`);

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

  // Save existing Reminders-synced tasks before wiping — these need to be restored after metadata generation
  const savedReminders: { chat_id: number; title: string; reminder_id: string; completed: boolean }[] = [];
  const savedCompletedTasks: { chat_id: number; title: string }[] = [];
  const savedRemovedEvents: { chat_id: number; title: string }[] = [];
  try {
    const pg = await getPglite();
    const reminderRows = await pg.query(
      'SELECT chat_id, title, reminder_id, completed FROM tasks WHERE reminder_id IS NOT NULL'
    );
    for (const row of reminderRows.rows as any[]) {
      savedReminders.push({ chat_id: row.chat_id, title: row.title, reminder_id: row.reminder_id, completed: row.completed });
    }
    // Also preserve user-completed tasks and user-removed events so they don't get recreated
    const completedRows = await pg.query('SELECT chat_id, title FROM tasks WHERE completed = true');
    for (const row of completedRows.rows as any[]) {
      savedCompletedTasks.push({ chat_id: row.chat_id, title: row.title });
    }
    const removedRows = await pg.query('SELECT chat_id, title FROM key_events WHERE removed = true');
    for (const row of removedRows.rows as any[]) {
      savedRemovedEvents.push({ chat_id: row.chat_id, title: row.title });
    }
    if (savedReminders.length > 0) {
      console.log(`[hard-reset] Saved ${savedReminders.length} Reminders-synced task(s) for restoration.`);
    }
    if (savedCompletedTasks.length > 0) {
      console.log(`[hard-reset] Saved ${savedCompletedTasks.length} completed task(s) to prevent recreation.`);
    }
    if (savedRemovedEvents.length > 0) {
      console.log(`[hard-reset] Saved ${savedRemovedEvents.length} removed event(s) to prevent recreation.`);
    }
  } catch {
    // DB may not exist yet on first run — that's fine
  }

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

  // Ingest last 120 days of messages
  const cutoffDate = new Date(Date.now() - 120 * 24 * 60 * 60 * 1000);
  updateSyncProgress('etl', 'Importing messages...', 5);
  const etlResult = await runETL(cutoffDate, 5);

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

  // Restore Reminders-synced tasks, completed tasks, and removed events from before the wipe
  if (savedReminders.length > 0 || savedCompletedTasks.length > 0 || savedRemovedEvents.length > 0) {
    console.log('\nRestoring pre-reset state...');

    // Restore reminder_id mappings by matching chat_id + title
    let restoredCount = 0;
    for (const saved of savedReminders) {
      const result = await pg.query(
        'UPDATE tasks SET reminder_id = $1 WHERE chat_id = $2 AND title = $3 AND reminder_id IS NULL',
        [saved.reminder_id, saved.chat_id, saved.title]
      );
      if ((result.affectedRows ?? 0) > 0) restoredCount++;
    }
    if (restoredCount > 0) {
      console.log(`[hard-reset] Restored ${restoredCount}/${savedReminders.length} Reminders mapping(s).`);
    }

    // Re-mark tasks that were previously completed by the user
    let recompletedCount = 0;
    for (const saved of savedCompletedTasks) {
      const result = await pg.query(
        'UPDATE tasks SET completed = true WHERE chat_id = $1 AND title = $2 AND completed = false',
        [saved.chat_id, saved.title]
      );
      if ((result.affectedRows ?? 0) > 0) recompletedCount++;
    }
    if (recompletedCount > 0) {
      console.log(`[hard-reset] Re-completed ${recompletedCount} task(s) that user had previously dismissed.`);
    }

    // Re-mark events that were previously removed by the user
    let reremovedCount = 0;
    for (const saved of savedRemovedEvents) {
      const result = await pg.query(
        'UPDATE key_events SET removed = true WHERE chat_id = $1 AND title = $2 AND (removed = false OR removed IS NULL)',
        [saved.chat_id, saved.title]
      );
      if ((result.affectedRows ?? 0) > 0) reremovedCount++;
    }
    if (reremovedCount > 0) {
      console.log(`[hard-reset] Re-removed ${reremovedCount} event(s) that user had previously dismissed.`);
    }
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

  // Load attachments for this chat's messages
  const attachments = extractAttachments(sqlite);
  await loadAttachments(pg, attachments);
  const maJoins = extractMessageAttachmentJoins(sqlite, sevenDaysAgo);
  const relevantMaJoins = maJoins.filter((j) => chatMessageIds.has(j.message_id));
  await loadMessageAttachmentJoins(pg, relevantMaJoins);

  await populateTextSearch(pg);
  sqlite.close();

  // Embed any new messages
  await embed({ batchSize: 200 });

  // Refresh metadata for just this chat
  await refreshChatMetadata(chatId, llmConfig);

  console.log(`[sync] Chat ${chatId}: ${newCount} new message(s), metadata refreshed.`);
  return { newMessages: newCount };
}

/**
 * Import older messages by extending the date range back further.
 * Embeds the new messages but does NOT run metadata/actions.
 */
export async function importOlderMessages(since: Date): Promise<{ messagesAdded: number; newMessageCount: number }> {
  console.log(`=== Import Older Messages (since ${since.toISOString().split('T')[0]}) ===`);
  updateSyncProgress('setup', 'Copying message database...', 0);
  await copyDb({ force: true });

  const pg = await getPglite();
  await initSchema();

  updateSyncProgress('etl', 'Importing older messages...', 5);
  const etlResult = await runETL(since, 5);

  // Embed new messages only
  console.log('Embedding new messages...');
  updateSyncProgress('embedding', 'Generating embeddings...', 50);
  await embed({ batchSize: 200 });

  updateSyncProgress('done', 'Complete!', 100);
  console.log(`Import complete: ${etlResult.newMessageCount} new message(s).`);
  return { messagesAdded: etlResult.messagesAdded, newMessageCount: etlResult.newMessageCount };
}
