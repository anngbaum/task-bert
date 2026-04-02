import type Database from 'better-sqlite3';
import type { RawMessage, Handle, Chat, ChatMessageJoin, ChatHandleJoin, Attachment, MessageAttachmentJoin } from '../types.js';
import { hasColumn } from '../db/sqlite-reader.js';

const APPLE_EPOCH_OFFSET = 978307200; // seconds between 1970-01-01 and 2001-01-01

/** Convert a JS Date to iMessage nanosecond timestamp */
function dateToImessageNano(date: Date): number {
  const unixSeconds = date.getTime() / 1000;
  return (unixSeconds - APPLE_EPOCH_OFFSET) * 1e9;
}

export function extractHandles(db: Database.Database): Handle[] {
  return db
    .prepare(
      `SELECT ROWID as id, id as identifier, service, person_centric_id
       FROM handle`
    )
    .all() as Handle[];
}

export function extractChats(db: Database.Database): Chat[] {
  return db
    .prepare(
      `SELECT ROWID as id, chat_identifier, service_name, display_name
       FROM chat`
    )
    .all() as Chat[];
}

export function* extractMessagesBatched(
  db: Database.Database,
  batchSize: number = 5000,
  afterDate?: Date
): Generator<RawMessage[]> {
  const whereClause = afterDate
    ? `WHERE date >= ${dateToImessageNano(afterDate)}`
    : '';

  const count = (
    db.prepare(`SELECT COUNT(*) as count FROM message ${whereClause}`).get() as { count: number }
  ).count;

  // associated_message_emoji was added in macOS 14+; older versions don't have it
  const hasEmoji = hasColumn(db, 'message', 'associated_message_emoji');
  const emojiCol = hasEmoji ? 'associated_message_emoji,' : '';

  for (let offset = 0; offset < count; offset += batchSize) {
    const rows = db
      .prepare(
        `SELECT ROWID as id, guid, text, attributedBody, is_from_me, date,
                date_read, date_delivered, handle_id, service,
                associated_message_type, associated_message_guid,
                ${emojiCol} thread_originator_guid,
                balloon_bundle_id,
                CASE WHEN cache_has_attachments = 1 THEN 1 ELSE 0 END as has_attachments
         FROM message
         ${whereClause}
         ORDER BY ROWID
         LIMIT ? OFFSET ?`
      )
      .all(batchSize, offset) as any[];
    // Normalize: ensure associated_message_emoji is always present
    if (!hasEmoji) {
      for (const row of rows) row.associated_message_emoji = null;
    }
    yield rows as RawMessage[];
  }
}

export function extractChatMessageJoins(db: Database.Database, afterDate?: Date): ChatMessageJoin[] {
  if (afterDate) {
    return db
      .prepare(
        `SELECT cmj.chat_id, cmj.message_id FROM chat_message_join cmj
         INNER JOIN message m ON m.ROWID = cmj.message_id
         WHERE m.date >= ${dateToImessageNano(afterDate)}`
      )
      .all() as ChatMessageJoin[];
  }
  return db
    .prepare('SELECT chat_id, message_id FROM chat_message_join')
    .all() as ChatMessageJoin[];
}

export function extractChatHandleJoins(db: Database.Database): ChatHandleJoin[] {
  return db
    .prepare('SELECT chat_id, handle_id FROM chat_handle_join')
    .all() as ChatHandleJoin[];
}

export function extractAttachments(db: Database.Database): Attachment[] {
  return db
    .prepare(
      `SELECT ROWID as id, guid, filename, mime_type, uti, total_bytes,
              transfer_name,
              CASE WHEN is_sticker = 1 THEN 1 ELSE 0 END as is_sticker,
              transfer_state
       FROM attachment`
    )
    .all()
    .map((row: any) => ({
      ...row,
      is_sticker: !!row.is_sticker,
    })) as Attachment[];
}

export function extractMessageAttachmentJoins(db: Database.Database, afterDate?: Date): MessageAttachmentJoin[] {
  if (afterDate) {
    return db
      .prepare(
        `SELECT maj.message_id, maj.attachment_id
         FROM message_attachment_join maj
         INNER JOIN message m ON m.ROWID = maj.message_id
         WHERE m.date >= ${dateToImessageNano(afterDate)}`
      )
      .all() as MessageAttachmentJoin[];
  }
  return db
    .prepare('SELECT message_id, attachment_id FROM message_attachment_join')
    .all() as MessageAttachmentJoin[];
}
