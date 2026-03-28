import { openSqlite, verifySqliteTables } from '../db/sqlite-reader.js';
import { getPglite, initSchema } from '../db/pglite-client.js';
import type { PGlite } from '@electric-sql/pglite';
import {
  extractHandles,
  extractChats,
  extractMessagesBatched,
  extractChatMessageJoins,
  extractChatHandleJoins,
} from '../etl/extract.js';
import { transformMessages } from '../etl/transform.js';
import { loadHandles, loadChats, loadMessages, loadChatMessageJoins, loadChatHandleJoins, loadLinkPreviews, populateTextSearch } from '../etl/load.js';
import { extractLinkPreviewRows, transformLinkPreviews } from '../etl/link-preview.js';
import { buildContactMap, resolveHandle } from '../contacts/address-book.js';

export interface IngestOptions {
  months?: number;
}

export async function ingest(options: IngestOptions = {}): Promise<void> {
  const afterDate = options.months
    ? new Date(Date.now() - options.months * 30 * 24 * 60 * 60 * 1000)
    : undefined;
  console.log('Opening SQLite database...');
  const sqlite = openSqlite();
  verifySqliteTables(sqlite);

  console.log('Initializing PGLite...');
  const pg = await getPglite();
  await initSchema();

  // Build contact lookup map from AddressBook
  console.log('Building contact map from AddressBook...');
  const contactMap = await buildContactMap();
  console.log(`  Found ${contactMap.size} contact entries`);

  // Load handles with resolved display names
  console.log('Extracting handles...');
  const handles = extractHandles(sqlite);
  let resolvedCount = 0;
  for (const handle of handles) {
    const displayName = resolveHandle(handle.identifier, contactMap);
    handle.display_name = displayName;
    if (displayName) resolvedCount++;
  }
  const handleCount = await loadHandles(pg, handles);
  console.log(`  Loaded ${handleCount} handles (resolved ${resolvedCount}/${handleCount} to contact names)`);

  // Load chats
  console.log('Extracting chats...');
  const chats = extractChats(sqlite);
  const chatCount = await loadChats(pg, chats);
  console.log(`  Loaded ${chatCount} chats`);

  // Load messages in batches
  if (afterDate) {
    console.log(`Extracting messages from last ${options.months} months (since ${afterDate.toISOString().split('T')[0]})...`);
  } else {
    console.log('Extracting and loading messages...');
  }
  let totalMessages = 0;
  const batchGen = extractMessagesBatched(sqlite, 5000, afterDate);
  for (const rawBatch of batchGen) {
    const transformed = transformMessages(rawBatch);
    const { totalProcessed } = await loadMessages(pg, transformed);
    totalMessages += totalProcessed;
    process.stdout.write(`  Loaded ${totalMessages} messages\r`);
  }
  console.log(`  Loaded ${totalMessages} messages total`);

  // Load join tables
  console.log('Extracting chat-message joins...');
  const cmJoins = extractChatMessageJoins(sqlite, afterDate);
  const cmCount = await loadChatMessageJoins(pg, cmJoins);
  console.log(`  Loaded ${cmCount} chat-message joins`);

  console.log('Extracting chat-handle joins...');
  const chJoins = extractChatHandleJoins(sqlite);
  const chCount = await loadChatHandleJoins(pg, chJoins);
  console.log(`  Loaded ${chCount} chat-handle joins`);

  // Extract and load link previews
  console.log('Extracting link previews...');
  const linkRows = extractLinkPreviewRows(sqlite, afterDate);
  const linkPreviews = transformLinkPreviews(linkRows);
  const linkCount = await loadLinkPreviews(pg, linkPreviews);
  console.log(`  Loaded ${linkCount} link previews`);

  // Populate full-text search vectors
  console.log('Populating text search index...');
  const ftsCount = await populateTextSearch(pg);
  console.log(`  Indexed ${ftsCount} messages for full-text search`);

  // Update last_synced so subsequent syncs know where to start
  await setLastSynced(pg, new Date());
  console.log('Updated last sync timestamp.');

  sqlite.close();
  console.log('\nIngestion complete!');
}

async function setLastSynced(pg: PGlite, date: Date): Promise<void> {
  await pg.query(
    `INSERT INTO sync_meta (id, last_synced) VALUES (1, $1)
     ON CONFLICT (id) DO UPDATE SET last_synced = $1`,
    [date.toISOString()]
  );
}
