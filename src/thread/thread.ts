import { getPglite } from '../db/pglite-client.js';
import type { ThreadMessage, ThreadAttachment, ThreadChatInfo, ThreadCursor, ThreadResponse } from '../types.js';

// --- Cursor helpers ---

export function encodeCursor(date: string, id: number): ThreadCursor {
  const raw = `${date}|${id}`;
  return Buffer.from(raw).toString('base64url');
}

export function decodeCursor(cursor: string): { date: string; id: number } {
  const raw = Buffer.from(cursor, 'base64url').toString('utf-8');
  const pipeIdx = raw.lastIndexOf('|');
  if (pipeIdx === -1) throw new Error('Invalid cursor');
  const date = raw.slice(0, pipeIdx);
  const id = parseInt(raw.slice(pipeIdx + 1), 10);
  if (isNaN(id)) throw new Error('Invalid cursor');
  return { date, id };
}

// --- DB helpers ---

async function getChatForMessage(messageId: number): Promise<ThreadChatInfo | null> {
  const db = await getPglite();

  const chatJoin = await db.query(
    `SELECT chat_id FROM chat_message_join WHERE message_id = $1 LIMIT 1`,
    [messageId]
  );
  if (chatJoin.rows.length === 0) return null;

  const chatId = (chatJoin.rows[0] as { chat_id: number }).chat_id;

  const chatResult = await db.query(
    `SELECT id, display_name, chat_identifier FROM chat WHERE id = $1`,
    [chatId]
  );
  if (chatResult.rows.length === 0) return null;

  const chat = chatResult.rows[0] as { id: number; display_name: string | null; chat_identifier: string };

  const participantResult = await db.query(
    `SELECT COALESCE(h.display_name, h.identifier) as name
     FROM chat_handle_join chj
     JOIN handle h ON chj.handle_id = h.id
     WHERE chj.chat_id = $1
     ORDER BY name`,
    [chatId]
  );

  const participants = (participantResult.rows as { name: string }[]).map(r => r.name);

  return {
    chat_id: chat.id,
    display_name: chat.display_name,
    chat_identifier: chat.chat_identifier,
    participants,
  };
}

interface PageResult {
  messages: ThreadMessage[];
  hasMore: boolean;
}

async function getThreadPage(
  chatId: number,
  direction: 'older' | 'newer',
  cursorDate: string,
  cursorId: number,
  limit: number
): Promise<PageResult> {
  const db = await getPglite();

  const condition = direction === 'older'
    ? `(m.date < $2::timestamptz OR (m.date = $2::timestamptz AND m.id < $3))`
    : `(m.date > $2::timestamptz OR (m.date = $2::timestamptz AND m.id > $3))`;

  const order = direction === 'older'
    ? 'ORDER BY m.date DESC, m.id DESC'
    : 'ORDER BY m.date ASC, m.id ASC';

  const query = `
    SELECT m.id, m.text, m.date, m.is_from_me, m.service,
           m.thread_originator_guid, m.has_attachments,
           COALESCE(h.display_name, h.identifier) as sender,
           lp.original_url as lp_original_url,
           lp.canonical_url as lp_canonical_url,
           lp.title as lp_title,
           lp.summary as lp_summary,
           lp.item_type as lp_item_type,
           lp.author as lp_author
    FROM message m
    JOIN chat_message_join cmj ON m.id = cmj.message_id
    LEFT JOIN handle h ON m.handle_id = h.id
    LEFT JOIN link_preview lp ON lp.message_id = m.id
    WHERE cmj.chat_id = $1
      AND ${condition}
      AND m.associated_message_type = 0
    ${order}
    LIMIT $4
  `;

  const result = await db.query(query, [chatId, cursorDate, cursorId, limit + 1]);
  const rows = result.rows as RawThreadRow[];
  const hasMore = rows.length > limit;
  const sliced = hasMore ? rows.slice(0, limit) : rows;

  // For 'older' direction, results came in DESC order — reverse to chronological
  if (direction === 'older') sliced.reverse();

  // Batch-load attachments for messages that have them
  const msgIdsWithAttachments = sliced.filter(r => r.has_attachments).map(r => r.id);
  const attachmentMap = await loadAttachmentsForMessages(msgIdsWithAttachments);

  return {
    messages: sliced.map(r => formatRow(r, attachmentMap.get(r.id) ?? [])),
    hasMore,
  };
}

// --- Attachment loading ---

async function loadAttachmentsForMessages(messageIds: number[]): Promise<Map<number, ThreadAttachment[]>> {
  if (messageIds.length === 0) return new Map();
  const db = await getPglite();
  const result = await db.query(
    `SELECT maj.message_id, a.id, a.filename, a.mime_type, a.uti,
            a.total_bytes, a.transfer_name, a.is_sticker
     FROM message_attachment_join maj
     JOIN attachment a ON a.id = maj.attachment_id
     WHERE maj.message_id = ANY($1::int[])`,
    [messageIds]
  );
  const map = new Map<number, ThreadAttachment[]>();
  for (const row of result.rows as any[]) {
    const msgId = row.message_id;
    if (!map.has(msgId)) map.set(msgId, []);
    map.get(msgId)!.push({
      id: row.id,
      filename: row.filename,
      mime_type: row.mime_type,
      uti: row.uti,
      total_bytes: row.total_bytes,
      transfer_name: row.transfer_name,
      is_sticker: row.is_sticker,
    });
  }
  return map;
}

// --- Row formatting ---

interface RawThreadRow {
  id: number;
  text: string | null;
  date: Date | null;
  is_from_me: boolean;
  service: string | null;
  thread_originator_guid: string | null;
  has_attachments: boolean;
  sender: string | null;
  lp_original_url: string | null;
  lp_canonical_url: string | null;
  lp_title: string | null;
  lp_summary: string | null;
  lp_item_type: string | null;
  lp_author: string | null;
}

function formatRow(row: RawThreadRow, attachments: ThreadAttachment[] = []): ThreadMessage {
  return {
    id: row.id,
    text: row.text,
    date: row.date ? row.date.toISOString() : null,
    is_from_me: row.is_from_me,
    sender: row.is_from_me ? null : row.sender,
    service: row.service,
    thread_originator_guid: row.thread_originator_guid,
    has_attachments: row.has_attachments,
    attachments,
    link_preview: row.lp_original_url ? {
      original_url: row.lp_original_url,
      canonical_url: row.lp_canonical_url,
      title: row.lp_title,
      summary: row.lp_summary,
      item_type: row.lp_item_type,
      author: row.lp_author,
    } : null,
  };
}

// --- Main entry point ---

export interface ThreadOptions {
  messageId: number;
  before?: number;
  after?: number;
  cursor?: string;
  direction?: 'older' | 'newer';
  limit?: number;
}

export async function getThread(options: ThreadOptions): Promise<ThreadResponse> {
  const { messageId, cursor, direction } = options;
  const db = await getPglite();

  // Always need the anchor message for chat resolution
  const anchorResult = await db.query(
    `SELECT m.id, m.text, m.date, m.is_from_me, m.service,
            m.thread_originator_guid, m.has_attachments,
            COALESCE(h.display_name, h.identifier) as sender,
            lp.original_url as lp_original_url,
            lp.canonical_url as lp_canonical_url,
            lp.title as lp_title,
            lp.summary as lp_summary,
            lp.item_type as lp_item_type,
            lp.author as lp_author
     FROM message m
     LEFT JOIN handle h ON m.handle_id = h.id
     LEFT JOIN link_preview lp ON lp.message_id = m.id
     WHERE m.id = $1`,
    [messageId]
  );

  if (anchorResult.rows.length === 0) {
    throw new NotFoundError(`Message ${messageId} not found`);
  }

  const anchorRow = anchorResult.rows[0] as RawThreadRow;
  const chatInfo = await getChatForMessage(messageId);
  if (!chatInfo) {
    throw new NotFoundError(`No chat found for message ${messageId}`);
  }

  // --- Cursor-based pagination ---
  if (cursor && direction) {
    const decoded = decodeCursor(cursor);
    const limit = options.limit ?? 50;
    const page = await getThreadPage(chatInfo.chat_id, direction, decoded.date, decoded.id, limit);

    const olderCursor = page.messages.length > 0
      ? encodeCursor(page.messages[0].date!, page.messages[0].id)
      : null;
    const newerCursor = page.messages.length > 0
      ? encodeCursor(page.messages[page.messages.length - 1].date!, page.messages[page.messages.length - 1].id)
      : null;

    return {
      chat: chatInfo,
      anchor_message_id: messageId,
      messages: page.messages,
      cursors: {
        older: direction === 'older' && page.hasMore ? olderCursor : (direction === 'newer' ? olderCursor : null),
        newer: direction === 'newer' && page.hasMore ? newerCursor : (direction === 'older' ? newerCursor : null),
      },
      has_older: direction === 'older' ? page.hasMore : page.messages.length > 0,
      has_newer: direction === 'newer' ? page.hasMore : page.messages.length > 0,
    };
  }

  // --- Initial load: messages around the anchor ---
  const beforeCount = options.before ?? 25;
  const afterCount = options.after ?? 25;
  const anchorDate = anchorRow.date ? anchorRow.date.toISOString() : new Date(0).toISOString();

  const [olderPage, newerPage] = await Promise.all([
    getThreadPage(chatInfo.chat_id, 'older', anchorDate, messageId, beforeCount),
    getThreadPage(chatInfo.chat_id, 'newer', anchorDate, messageId, afterCount),
  ]);

  // Load attachments for the anchor message
  const anchorAttachments = anchorRow.has_attachments
    ? (await loadAttachmentsForMessages([anchorRow.id])).get(anchorRow.id) ?? []
    : [];

  const allMessages = [
    ...olderPage.messages,
    formatRow(anchorRow, anchorAttachments),
    ...newerPage.messages,
  ];

  const olderCursor = allMessages.length > 0
    ? encodeCursor(allMessages[0].date!, allMessages[0].id)
    : null;
  const newerCursor = allMessages.length > 0
    ? encodeCursor(allMessages[allMessages.length - 1].date!, allMessages[allMessages.length - 1].id)
    : null;

  return {
    chat: chatInfo,
    anchor_message_id: messageId,
    messages: allMessages,
    cursors: { older: olderCursor, newer: newerCursor },
    has_older: olderPage.hasMore,
    has_newer: newerPage.hasMore,
  };
}

export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}
