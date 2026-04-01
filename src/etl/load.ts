import type { PGlite } from '@electric-sql/pglite';
import type { Handle, Chat, Message, ChatMessageJoin, ChatHandleJoin, LinkPreview, Attachment, MessageAttachmentJoin } from '../types.js';

const MULTI_ROW_BATCH = 500;

/**
 * Build a multi-row INSERT statement with parameterized placeholders.
 * Returns the SQL string and flat params array.
 */
function buildMultiInsert(
  table: string,
  columns: string[],
  rows: unknown[][],
  onConflict: string = 'DO NOTHING'
): { sql: string; params: unknown[] } {
  const params: unknown[] = [];
  const colCount = columns.length;
  const valueSets: string[] = [];

  for (let i = 0; i < rows.length; i++) {
    const placeholders: string[] = [];
    for (let j = 0; j < colCount; j++) {
      const paramIdx = i * colCount + j + 1;
      placeholders.push(`$${paramIdx}`);
      params.push(rows[i][j]);
    }
    valueSets.push(`(${placeholders.join(', ')})`);
  }

  const sql = `INSERT INTO ${table} (${columns.join(', ')}) VALUES ${valueSets.join(', ')} ON CONFLICT ${onConflict}`;
  return { sql, params };
}

export async function loadHandles(db: PGlite, handles: Handle[]): Promise<number> {
  const columns = ['id', 'identifier', 'service', 'person_centric_id', 'display_name'];
  let loaded = 0;

  for (let i = 0; i < handles.length; i += MULTI_ROW_BATCH) {
    const batch = handles.slice(i, i + MULTI_ROW_BATCH);
    const rows = batch.map((h) => [h.id, h.identifier, h.service, h.person_centric_id, h.display_name]);
    const { sql, params } = buildMultiInsert('handle', columns, rows, '(id) DO NOTHING');
    await db.query(sql, params);
    loaded += batch.length;
  }

  return loaded;
}

export async function loadChats(db: PGlite, chats: Chat[]): Promise<number> {
  const columns = ['id', 'chat_identifier', 'service_name', 'display_name'];
  let loaded = 0;

  for (let i = 0; i < chats.length; i += MULTI_ROW_BATCH) {
    const batch = chats.slice(i, i + MULTI_ROW_BATCH);
    const rows = batch.map((c) => [c.id, c.chat_identifier, c.service_name, c.display_name]);
    const { sql, params } = buildMultiInsert('chat', columns, rows, '(id) DO NOTHING');
    await db.query(sql, params);
    loaded += batch.length;
  }

  return loaded;
}

export interface LoadMessagesResult {
  totalProcessed: number;
  newMessageIds: Set<number>;
}

export async function loadMessages(db: PGlite, messages: Message[]): Promise<LoadMessagesResult> {
  let totalProcessed = 0;
  const newMessageIds = new Set<number>();

  for (let i = 0; i < messages.length; i += MULTI_ROW_BATCH) {
    const batch = messages.slice(i, i + MULTI_ROW_BATCH);
    const batchIds = batch.map((m) => m.id);

    // Check which IDs already exist and which have null text (will be updated)
    const existing = await db.query(
      `SELECT id, text FROM message WHERE id = ANY($1::int[])`,
      [batchIds]
    );
    const existingById = new Map((existing.rows as { id: number; text: string | null }[]).map((r) => [r.id, r.text]));
    const batchById = new Map(batch.map((m) => [m.id, m.text]));
    for (const id of batchIds) {
      if (!existingById.has(id)) {
        // Genuinely new message
        newMessageIds.add(id);
      } else if (existingById.get(id) == null && batchById.get(id) != null) {
        // Existing message getting its text populated (e.g. attributedBody fix)
        newMessageIds.add(id);
      }
    }

    // Build multi-row insert. We handle tsvector separately with a post-UPDATE
    // to keep the INSERT simple and avoid issues with problematic text.
    const columns = [
      'id', 'guid', 'text', 'is_from_me', 'date', 'date_read', 'date_delivered',
      'handle_id', 'service', 'associated_message_type',
      'associated_message_guid', 'associated_message_emoji',
      'thread_originator_guid', 'balloon_bundle_id', 'has_attachments',
    ];

    const rows = batch.map((m) => [
      m.id,
      m.guid,
      m.text,
      m.is_from_me,
      m.date?.toISOString() ?? null,
      m.date_read?.toISOString() ?? null,
      m.date_delivered?.toISOString() ?? null,
      m.handle_id,
      m.service,
      m.associated_message_type,
      m.associated_message_guid,
      m.associated_message_emoji,
      m.thread_originator_guid,
      m.balloon_bundle_id,
      m.has_attachments,
    ]);

    try {
      const { sql, params } = buildMultiInsert('message', columns, rows,
        '(id) DO UPDATE SET text = EXCLUDED.text WHERE message.text IS NULL AND EXCLUDED.text IS NOT NULL');
      await db.query(sql, params);
      totalProcessed += batch.length;
    } catch {
      // Fall back to individual inserts on error
      for (const m of batch) {
        try {
          await db.query(
            `INSERT INTO message (id, guid, text, is_from_me, date, date_read, date_delivered,
                                  handle_id, service, associated_message_type,
                                  associated_message_guid, associated_message_emoji,
                                  thread_originator_guid, balloon_bundle_id, has_attachments)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
             ON CONFLICT (id) DO UPDATE SET text = EXCLUDED.text WHERE message.text IS NULL AND EXCLUDED.text IS NOT NULL`,
            [
              m.id, m.guid, m.text, m.is_from_me,
              m.date?.toISOString() ?? null,
              m.date_read?.toISOString() ?? null,
              m.date_delivered?.toISOString() ?? null,
              m.handle_id, m.service, m.associated_message_type,
              m.associated_message_guid, m.associated_message_emoji,
              m.thread_originator_guid, m.balloon_bundle_id, m.has_attachments,
            ]
          );
          totalProcessed++;
        } catch {
          // Skip problematic messages
        }
      }
    }
  }

  return { totalProcessed, newMessageIds };
}

/**
 * Given the full set of chat-message joins and a set of new message IDs,
 * return the chat IDs that received new messages.
 */
export function getAffectedChatIds(joins: ChatMessageJoin[], newMessageIds: Set<number>): Set<number> {
  const chatIds = new Set<number>();
  for (const join of joins) {
    if (newMessageIds.has(join.message_id)) {
      chatIds.add(join.chat_id);
    }
  }
  return chatIds;
}

export async function loadChatMessageJoins(
  db: PGlite,
  joins: ChatMessageJoin[]
): Promise<number> {
  const columns = ['chat_id', 'message_id'];
  let loaded = 0;

  for (let i = 0; i < joins.length; i += MULTI_ROW_BATCH) {
    const batch = joins.slice(i, i + MULTI_ROW_BATCH);
    const rows = batch.map((j) => [j.chat_id, j.message_id]);
    try {
      const { sql, params } = buildMultiInsert('chat_message_join', columns, rows);
      await db.query(sql, params);
    } catch {
      // Ignore conflicts
    }
    loaded += batch.length;
  }

  return loaded;
}

export async function loadChatHandleJoins(
  db: PGlite,
  joins: ChatHandleJoin[]
): Promise<number> {
  const columns = ['chat_id', 'handle_id'];
  let loaded = 0;

  for (let i = 0; i < joins.length; i += MULTI_ROW_BATCH) {
    const batch = joins.slice(i, i + MULTI_ROW_BATCH);
    const rows = batch.map((j) => [j.chat_id, j.handle_id]);
    try {
      const { sql, params } = buildMultiInsert('chat_handle_join', columns, rows);
      await db.query(sql, params);
    } catch {
      // Ignore conflicts
    }
    loaded += batch.length;
  }

  return loaded;
}

export async function loadLinkPreviews(db: PGlite, previews: LinkPreview[]): Promise<number> {
  if (previews.length === 0) return 0;

  const columns = ['message_id', 'original_url', 'canonical_url', 'title', 'summary', 'item_type', 'author'];
  let loaded = 0;

  for (let i = 0; i < previews.length; i += MULTI_ROW_BATCH) {
    const batch = previews.slice(i, i + MULTI_ROW_BATCH);
    const rows = batch.map((p) => [
      p.message_id,
      p.original_url,
      p.canonical_url,
      p.title,
      p.summary,
      p.item_type,
      p.author,
    ]);
    try {
      const { sql, params } = buildMultiInsert('link_preview', columns, rows, '(message_id) DO NOTHING');
      await db.query(sql, params);
      loaded += batch.length;
    } catch {
      for (const p of batch) {
        try {
          await db.query(
            `INSERT INTO link_preview (message_id, original_url, canonical_url, title, summary, item_type, author)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             ON CONFLICT (message_id) DO NOTHING`,
            [p.message_id, p.original_url, p.canonical_url, p.title, p.summary, p.item_type, p.author]
          );
          loaded++;
        } catch {
          // Skip problematic rows
        }
      }
    }
  }

  return loaded;
}

export async function loadAttachments(db: PGlite, attachments: Attachment[]): Promise<number> {
  if (attachments.length === 0) return 0;

  const columns = ['id', 'guid', 'filename', 'mime_type', 'uti', 'total_bytes', 'transfer_name', 'is_sticker', 'transfer_state'];
  let loaded = 0;

  for (let i = 0; i < attachments.length; i += MULTI_ROW_BATCH) {
    const batch = attachments.slice(i, i + MULTI_ROW_BATCH);
    const rows = batch.map((a) => [
      a.id, a.guid, a.filename, a.mime_type, a.uti,
      a.total_bytes, a.transfer_name, a.is_sticker, a.transfer_state,
    ]);
    try {
      const { sql, params } = buildMultiInsert('attachment', columns, rows, '(id) DO NOTHING');
      await db.query(sql, params);
      loaded += batch.length;
    } catch {
      for (const a of batch) {
        try {
          await db.query(
            `INSERT INTO attachment (id, guid, filename, mime_type, uti, total_bytes, transfer_name, is_sticker, transfer_state)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
             ON CONFLICT (id) DO NOTHING`,
            [a.id, a.guid, a.filename, a.mime_type, a.uti, a.total_bytes, a.transfer_name, a.is_sticker, a.transfer_state]
          );
          loaded++;
        } catch {
          // Skip problematic rows
        }
      }
    }
  }

  return loaded;
}

export async function loadMessageAttachmentJoins(db: PGlite, joins: MessageAttachmentJoin[]): Promise<number> {
  if (joins.length === 0) return 0;

  const columns = ['message_id', 'attachment_id'];
  let loaded = 0;

  for (let i = 0; i < joins.length; i += MULTI_ROW_BATCH) {
    const batch = joins.slice(i, i + MULTI_ROW_BATCH);
    const rows = batch.map((j) => [j.message_id, j.attachment_id]);
    try {
      const { sql, params } = buildMultiInsert('message_attachment_join', columns, rows);
      await db.query(sql, params);
    } catch {
      // Ignore conflicts
    }
    loaded += batch.length;
  }

  return loaded;
}

/**
 * Populate tsvector column for messages that have text but no text_search.
 * Done as a separate step to avoid issues with individual message text
 * breaking to_tsvector.
 */
export async function populateTextSearch(db: PGlite): Promise<number> {
  // Index message text combined with link preview title/summary when available
  const result = await db.query(
    `UPDATE message m
     SET text_search = to_tsvector('english',
       COALESCE(m.text, '') || ' ' ||
       COALESCE(lp.title, '') || ' ' ||
       COALESCE(lp.summary, '')
     )
     FROM link_preview lp
     WHERE lp.message_id = m.id AND m.text_search IS NULL`
  );

  // Also index messages without link previews (original behavior)
  const result2 = await db.query(
    `UPDATE message m
     SET text_search = to_tsvector('english', m.text)
     WHERE m.text IS NOT NULL AND m.text != '' AND m.text_search IS NULL
       AND NOT EXISTS (SELECT 1 FROM link_preview lp WHERE lp.message_id = m.id)`
  );

  return (result.affectedRows ?? 0) + (result2.affectedRows ?? 0);
}
