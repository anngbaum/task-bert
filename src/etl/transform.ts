import type { RawMessage, Message } from '../types.js';
import { imessageDateToJS } from '../parsers/timestamps.js';

// U+FFFC = Object Replacement Character (used for inline attachments)
const OBJECT_REPLACEMENT_CHAR = '\ufffc';

/**
 * Extract readable text from iMessage attributedBody blob.
 *
 * The attributedBody is an NSKeyedArchiver (typedstream) encoded
 * NSMutableAttributedString. The text content is stored as a UTF-8
 * string after the class hierarchy definitions.
 *
 * Format after "NSString" class marker:
 *   \x01\x95\x84\x01\x2b <length_byte> <utf8_text>     (short strings, length < 128)
 *   \x01\x95\x84\x01\x69 <4-byte BE length> <utf8_text> (long strings)
 *
 * We search for the \x01\x2b or \x01\x69 patterns after "NSString".
 */
function extractTextFromAttributedBody(blob: Buffer | null): string | null {
  if (!blob || blob.length === 0) return null;

  try {
    const buf = Buffer.from(blob);
    const nsStringIdx = buf.indexOf('NSString');
    if (nsStringIdx === -1) return null;

    const searchStart = nsStringIdx + 8; // past "NSString"
    const searchEnd = Math.min(searchStart + 40, buf.length - 2);

    for (let i = searchStart; i < searchEnd; i++) {
      if (buf[i] !== 0x01) continue;

      const tag = buf[i + 1];

      if (tag === 0x2b) {
        // Next byte(s) encode the length. If < 0x80, it's the length directly.
        // If 0x81, the next 2 bytes are a 16-bit big-endian length.
        const lenByte = buf[i + 2];
        let len: number;
        let textStart: number;
        if (lenByte < 0x80) {
          len = lenByte;
          textStart = i + 3;
        } else if (lenByte === 0x81) {
          // 0x81 signals a 2-byte little-endian length follows
          if (i + 5 > buf.length) return null;
          len = buf.readUInt16LE(i + 3);
          textStart = i + 5;
        } else {
          return null; // unsupported multi-byte length
        }
        if (textStart + len > buf.length) return null;
        const raw = buf.subarray(textStart, textStart + len).toString('utf-8');
        return cleanExtractedText(raw);
      }

      if (tag === 0x69) {
        // Long string: next 4 bytes are length (big-endian)
        if (i + 6 > buf.length) return null;
        const len = buf.readUInt32BE(i + 2);
        if (i + 6 + len > buf.length) return null;
        const raw = buf.subarray(i + 6, i + 6 + len).toString('utf-8');
        return cleanExtractedText(raw);
      }
    }

    return null;
  } catch {
    return null;
  }
}

function cleanExtractedText(raw: string): string | null {
  // Remove U+FFFC (object replacement characters for inline attachments)
  const cleaned = raw.replace(new RegExp(OBJECT_REPLACEMENT_CHAR, 'g'), '').trim();
  return cleaned.length > 0 ? cleaned : null;
}

export function transformMessage(raw: RawMessage): Message {
  let text = raw.text;

  // Fall back to extracting from attributedBody if text is null
  if (text == null && raw.attributedBody != null) {
    text = extractTextFromAttributedBody(raw.attributedBody);
  }

  return {
    id: raw.id,
    guid: raw.guid,
    text,
    is_from_me: raw.is_from_me === 1,
    date: imessageDateToJS(raw.date),
    date_read: imessageDateToJS(raw.date_read),
    date_delivered: imessageDateToJS(raw.date_delivered),
    handle_id: raw.handle_id,
    service: raw.service,
    associated_message_type: raw.associated_message_type,
    associated_message_guid: raw.associated_message_guid,
    associated_message_emoji: raw.associated_message_emoji,
    thread_originator_guid: raw.thread_originator_guid,
    balloon_bundle_id: raw.balloon_bundle_id,
    has_attachments: raw.has_attachments === 1,
  };
}

export function transformMessages(rawMessages: RawMessage[]): Message[] {
  return rawMessages.map(transformMessage);
}
