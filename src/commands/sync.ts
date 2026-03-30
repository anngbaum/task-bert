import { openSqlite, verifySqliteTables } from '../db/sqlite-reader.js';
import { getPglite, initSchema } from '../db/pglite-client.js';
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
import { loadHandles, loadChats, loadMessages, loadChatMessageJoins, loadChatHandleJoins, loadLinkPreviews, loadAttachments, loadMessageAttachmentJoins, populateTextSearch } from '../etl/load.js';
import { extractLinkPreviewRows, transformLinkPreviews } from '../etl/link-preview.js';
import { buildContactMap, resolveHandle } from '../contacts/address-book.js';

export interface SyncResult {
  messagesAdded: number;
  handlesAdded: number;
  lastSynced: string;
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

export async function sync(): Promise<SyncResult> {
  // 1. Copy fresh chat.db
  console.log('Copying fresh chat.db...');
  await copyDb({ force: true });

  // 2. Initialize PGLite and schema
  console.log('Initializing PGLite...');
  const pg = await getPglite();
  await initSchema();

  // 3. Read last_synced
  const lastSynced = await getLastSynced(pg);
  const cutoffDate = new Date(Date.now() - 120 * 24 * 60 * 60 * 1000);
  const afterDate = lastSynced ?? cutoffDate;
  console.log(lastSynced
    ? `Last synced: ${lastSynced.toISOString()}`
    : `No previous sync found — importing messages from last 3 months`
  );

  // 4. Open SQLite and extract
  console.log('Opening SQLite database...');
  const sqlite = openSqlite();
  verifySqliteTables(sqlite);

  // 5. Load any new handles (with contact resolution)
  console.log('Syncing handles...');
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

  // 6. Load any new chats
  console.log('Syncing chats...');
  const chats = extractChats(sqlite);
  await loadChats(pg, chats);

  // 7. Load new messages
  console.log(`Extracting messages since ${afterDate.toISOString().split('T')[0]}...`);
  let totalMessages = 0;
  const batchGen = extractMessagesBatched(sqlite, 5000, afterDate);
  for (const rawBatch of batchGen) {
    const transformed = transformMessages(rawBatch);
    const { totalProcessed } = await loadMessages(pg, transformed);
    totalMessages += totalProcessed;
    process.stdout.write(`  Loaded ${totalMessages} messages\r`);
  }
  console.log(`  Loaded ${totalMessages} new messages total`);

  // 8. Load join tables for new messages
  console.log('Syncing chat-message joins...');
  const cmJoins = extractChatMessageJoins(sqlite, afterDate);
  await loadChatMessageJoins(pg, cmJoins);

  console.log('Syncing chat-handle joins...');
  const chJoins = extractChatHandleJoins(sqlite);
  await loadChatHandleJoins(pg, chJoins);

  // 8b. Extract and load link previews
  console.log('Extracting link previews...');
  const linkRows = extractLinkPreviewRows(sqlite, afterDate);
  const linkPreviews = transformLinkPreviews(linkRows);
  const linkCount = await loadLinkPreviews(pg, linkPreviews);
  console.log(`  Loaded ${linkCount} link previews`);

  // 8c. Extract and load attachments
  console.log('Syncing attachments...');
  const attachments = extractAttachments(sqlite);
  const attachmentCount = await loadAttachments(pg, attachments);
  console.log(`  Loaded ${attachmentCount} attachments`);
  const maJoins = extractMessageAttachmentJoins(sqlite, afterDate);
  await loadMessageAttachmentJoins(pg, maJoins);
  console.log(`  Loaded ${maJoins.length} message-attachment joins`);

  // 9. Populate FTS for new messages
  console.log('Updating text search index...');
  const ftsCount = await populateTextSearch(pg);
  console.log(`  Indexed ${ftsCount} messages for full-text search`);

  // 10. Update last_synced
  const now = new Date();
  await setLastSynced(pg, now);

  sqlite.close();
  console.log('\nSync complete!');

  return {
    messagesAdded: totalMessages,
    handlesAdded: handleCount,
    lastSynced: now.toISOString(),
  };
}
