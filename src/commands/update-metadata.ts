import { getPglite } from '../db/pglite-client.js';
import { callLLM } from '../llm/query-parser.js';
import type { LLMConfig } from '../llm/query-parser.js';
import { updateSyncProgress } from '../progress.js';

interface ChatMessage {
  id: number;
  sender: string;
  text: string;
  date: string;
}

interface ChatMessages {
  chatId: number;
  chatName: string;
  messages: ChatMessage[];
}

async function getLastMetadataUpdate(): Promise<Date | null> {
  const db = await getPglite();
  const result = await db.query('SELECT last_updated FROM metadata_meta WHERE id = 1');
  if (result.rows.length === 0) return null;
  return new Date((result.rows[0] as { last_updated: string }).last_updated);
}

async function setLastMetadataUpdate(date: Date): Promise<void> {
  const db = await getPglite();
  await db.query(
    `INSERT INTO metadata_meta (id, last_updated) VALUES (1, $1)
     ON CONFLICT (id) DO UPDATE SET last_updated = $1`,
    [date.toISOString()]
  );
}

/**
 * Find chats with messages since `since`, and return the 30 most recent
 * messages from each of those chats (for context).
 */
async function getChatsWithNewMessages(since: Date | null, minMessages: number = 1): Promise<ChatMessages[]> {
  const db = await getPglite();

  // Find chat IDs that have new messages since the cutoff
  const afterDate = since ?? new Date('2000-01-01');
  const chatsResult = await db.query(
    `SELECT cmj.chat_id, COUNT(*) as msg_count
     FROM message m
     JOIN chat_message_join cmj ON cmj.message_id = m.id
     WHERE m.date > $1
       AND m.text IS NOT NULL AND m.text != ''
       AND m.associated_message_type = 0
     GROUP BY cmj.chat_id
     HAVING COUNT(*) >= $2`,
    [afterDate.toISOString(), minMessages]
  );

  const chatIds = (chatsResult.rows as { chat_id: number }[]).map((r) => r.chat_id);
  if (chatIds.length === 0) return [];

  const result: ChatMessages[] = [];

  for (const chatId of chatIds) {
    // Get chat display name
    const chatResult = await db.query(
      'SELECT display_name, chat_identifier FROM chat WHERE id = $1',
      [chatId]
    );
    const chat = chatResult.rows[0] as { display_name: string | null; chat_identifier: string } | undefined;
    const chatName = chat?.display_name || chat?.chat_identifier || `Chat ${chatId}`;

    // Get 20 most recent messages with sender info
    const msgResult = await db.query(
      `SELECT m.id, m.text, m.is_from_me, m.date,
              COALESCE(h.display_name, h.identifier, 'Unknown') as sender
       FROM message m
       JOIN chat_message_join cmj ON cmj.message_id = m.id
       LEFT JOIN handle h ON h.id = m.handle_id
       WHERE cmj.chat_id = $1
         AND m.text IS NOT NULL AND m.text != ''
         AND m.associated_message_type = 0
       ORDER BY m.date DESC
       LIMIT 20`,
      [chatId]
    );

    const messages = (msgResult.rows as any[])
      .reverse() // chronological order
      .map((r) => ({
        id: r.id,
        sender: r.is_from_me ? 'Me' : r.sender,
        text: r.text,
        date: new Date(r.date).toISOString(),
      }));

    if (messages.length > 0) {
      result.push({ chatId, chatName, messages });
    }
  }

  return result;
}

function buildMetadataPrompt(chats: ChatMessages[]): string {
  const chatBlocks = chats.map((c) => {
    const msgLines = c.messages.map((m) =>
      `[${m.date}] ${m.sender}: ${m.text}`
    ).join('\n');
    return `=== Chat ${c.chatId}: "${c.chatName}" ===\n${msgLines}`;
  }).join('\n\n');

  return chatBlocks;
}

export interface MetadataOptions {
  since?: Date;
  minMessages?: number;
  /** If set, run action extraction with a separate (wider) time window */
  actionsSince?: Date;
  /** If true, skip action extraction entirely (caller will handle it) */
  skipActions?: boolean;
}

/**
 * Find chats that have messages but no entry in chat_metadata yet.
 */
async function getChatsWithoutMetadata(since: Date, minMessages: number = 1): Promise<ChatMessages[]> {
  const db = await getPglite();

  const chatsResult = await db.query(
    `SELECT cmj.chat_id, COUNT(*) as msg_count
     FROM message m
     JOIN chat_message_join cmj ON cmj.message_id = m.id
     LEFT JOIN chat_metadata cm ON cm.chat_id = cmj.chat_id
     WHERE cm.chat_id IS NULL
       AND m.date > $1
       AND m.text IS NOT NULL AND m.text != ''
       AND m.associated_message_type = 0
     GROUP BY cmj.chat_id
     HAVING COUNT(*) >= $2`,
    [since.toISOString(), minMessages]
  );

  const chatIds = (chatsResult.rows as { chat_id: number }[]).map((r) => r.chat_id);
  if (chatIds.length === 0) return [];

  const result: ChatMessages[] = [];

  for (const chatId of chatIds) {
    const chatResult = await db.query(
      'SELECT display_name, chat_identifier FROM chat WHERE id = $1',
      [chatId]
    );
    const chat = chatResult.rows[0] as { display_name: string | null; chat_identifier: string } | undefined;
    const chatName = chat?.display_name || chat?.chat_identifier || `Chat ${chatId}`;

    const msgResult = await db.query(
      `SELECT m.id, m.text, m.is_from_me, m.date,
              COALESCE(h.display_name, h.identifier, 'Unknown') as sender
       FROM message m
       JOIN chat_message_join cmj ON cmj.message_id = m.id
       LEFT JOIN handle h ON h.id = m.handle_id
       WHERE cmj.chat_id = $1
         AND m.text IS NOT NULL AND m.text != ''
         AND m.associated_message_type = 0
       ORDER BY m.date DESC
       LIMIT 20`,
      [chatId]
    );

    const messages = (msgResult.rows as any[])
      .reverse()
      .map((r) => ({
        id: r.id,
        sender: r.is_from_me ? 'Me' : r.sender,
        text: r.text,
        date: new Date(r.date).toISOString(),
      }));

    if (messages.length > 0) {
      result.push({ chatId, chatName, messages });
    }
  }

  return result;
}

export async function updateMetadata(config: LLMConfig, options: MetadataOptions = {}): Promise<number> {
  const since = options.since ?? await getLastMetadataUpdate();
  const minMessages = options.minMessages ?? 1;
  // Cap to 60 days max to avoid summarizing ancient conversations
  const sixtyDaysAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
  // Use whichever is more recent: the requested date or 60 days ago
  const effectiveSince = since && since > sixtyDaysAgo ? since : sixtyDaysAgo;
  const chats = await getChatsWithNewMessages(effectiveSince, minMessages);

  // Also pick up any chats that are missing metadata entirely (within the same window)
  const missingChats = await getChatsWithoutMetadata(effectiveSince, minMessages);
  const existingChatIds = new Set(chats.map((c) => c.chatId));
  for (const mc of missingChats) {
    if (!existingChatIds.has(mc.chatId)) {
      chats.push(mc);
    }
  }
  if (missingChats.length > 0) {
    console.log(`[metadata] Found ${missingChats.length} chat(s) missing metadata.`);
  }

  if (chats.length === 0) {
    console.log('[metadata] No chats with new messages to summarize.');
    return 0;
  }

  console.log(`[metadata] Summarizing ${chats.length} chat(s)...`);

  const now = new Date();
  const today = now.toISOString().split('T')[0];
  const db = await getPglite();

  let totalSummaries = 0;

  for (let i = 0; i < chats.length; i++) {
    const chat = chats[i];
    console.log(`  [metadata] ${i + 1}/${chats.length}: "${chat.chatName}"...`);
    updateSyncProgress('metadata', `Summarizing chat ${i + 1}/${chats.length}: ${chat.chatName}`, 85 + Math.round((i / chats.length) * 12));

    try {
      const msgLines = chat.messages.map((m) =>
        `[${m.date}] ${m.sender}: ${m.text}`
      ).join('\n');

      const summary = (await callLLM(
        config,
        `You summarize iMessage conversations. Today is ${today}.

Produce a brief 1-3 sentence summary capturing the key topics, tone, and any notable context (plans being made, questions asked, etc.).

Respond with ONLY the summary text. No JSON, no markdown, no explanation.`,
        `=== Chat "${chat.chatName}" ===\n${msgLines}`,
        512
      )).trim();

      await db.query(
        `INSERT INTO chat_metadata (chat_id, summary, last_updated)
         VALUES ($1, $2, $3)
         ON CONFLICT (chat_id) DO UPDATE SET summary = $2, last_updated = $3`,
        [chat.chatId, summary, now.toISOString()]
      );
      totalSummaries++;
      console.log(`    → ${summary.slice(0, 100)}${summary.length > 100 ? '...' : ''}`);
    } catch (err) {
      console.error(`    ✗ Failed: ${(err as Error).message}`);
    }
  }

  // Run action extraction — optionally with a wider time window
  if (!options.skipActions) {
    if (options.actionsSince) {
      // Fetch a broader set of chats for action extraction
      const actionChats = await getChatsWithNewMessages(options.actionsSince, minMessages);
      const actionChatIds = new Set(actionChats.map((c) => c.chatId));
      // Also include any chats we already fetched for summaries
      for (const c of chats) {
        if (!actionChatIds.has(c.chatId)) {
          actionChats.push(c);
        }
      }
      console.log(`[actions] Checking ${actionChats.length} chat(s) active since ${options.actionsSince.toISOString().split('T')[0]}...`);
      await updateActions(config, actionChats);
    } else {
      await updateActions(config, chats);
    }
  }

  // Only advance the timestamp if at least one summary succeeded —
  // otherwise failed chats would be permanently skipped on retry.
  if (totalSummaries > 0) {
    await setLastMetadataUpdate(now);
  }
  console.log(`\n[metadata] Updated summaries for ${totalSummaries}/${chats.length} chat(s).`);
  return totalSummaries;
}

export async function refreshChatMetadata(chatId: number, config: LLMConfig): Promise<string> {
  const db = await getPglite();

  // Get chat info
  const chatResult = await db.query(
    'SELECT display_name, chat_identifier FROM chat WHERE id = $1',
    [chatId]
  );
  const chat = chatResult.rows[0] as { display_name: string | null; chat_identifier: string } | undefined;
  if (!chat) throw new Error(`Chat ${chatId} not found`);
  const chatName = chat.display_name || chat.chat_identifier;

  // Get 30 most recent messages
  const msgResult = await db.query(
    `SELECT m.text, m.is_from_me, m.date,
            COALESCE(h.display_name, h.identifier, 'Unknown') as sender
     FROM message m
     JOIN chat_message_join cmj ON cmj.message_id = m.id
     LEFT JOIN handle h ON h.id = m.handle_id
     WHERE cmj.chat_id = $1
       AND m.text IS NOT NULL AND m.text != ''
       AND m.associated_message_type = 0
     ORDER BY m.date DESC
     LIMIT 30`,
    [chatId]
  );

  const messages = (msgResult.rows as any[])
    .reverse()
    .map((r) => ({
      sender: r.is_from_me ? 'Me' : r.sender,
      text: r.text,
      date: new Date(r.date).toISOString(),
    }));

  if (messages.length === 0) throw new Error(`No messages found for chat ${chatId}`);

  const today = new Date().toISOString().split('T')[0];

  const msgLines = messages.map((m) => `[${m.date}] ${m.sender}: ${m.text}`).join('\n');

  const summary = (await callLLM(
    config,
    `You summarize iMessage conversations. Today is ${today}.

Given a message thread, produce a brief 1-3 sentence summary capturing the key topics, tone, and any notable context (plans being made, questions asked, etc.).

Respond with ONLY the summary text. No JSON, no markdown, no explanation.`,
    `=== Chat "${chatName}" ===\n${msgLines}`,
    512
  )).trim();
  const now = new Date();

  await db.query(
    `INSERT INTO chat_metadata (chat_id, summary, last_updated)
     VALUES ($1, $2, $3)
     ON CONFLICT (chat_id) DO UPDATE SET summary = $2, last_updated = $3`,
    [chatId, summary, now.toISOString()]
  );

  return summary;
}

export async function updateActions(config: LLMConfig, chats?: ChatMessages[]): Promise<number> {
  if (!chats) {
    const since = await getLastMetadataUpdate();
    chats = await getChatsWithNewMessages(since);
  }

  const db = await getPglite();

  if (chats.length === 0) {
    console.log('[actions] No new messages to check for actions.');
    return 0;
  }

  const now = new Date();
  const today = now.toISOString().split('T')[0];
  const twoWeeksAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);

  // Split chats into recent (≤2 weeks) and older (>2 weeks) based on latest message
  const recentChats: ChatMessages[] = [];
  const olderChats: ChatMessages[] = [];
  for (const chat of chats) {
    const latestMsg = chat.messages[chat.messages.length - 1];
    const latestDate = latestMsg ? new Date(latestMsg.date) : new Date(0);
    if (latestDate >= twoWeeksAgo) {
      recentChats.push(chat);
    } else {
      olderChats.push(chat);
    }
  }

  console.log(`[actions] Checking ${chats.length} chat(s) — ${recentChats.length} recent, ${olderChats.length} older (events-only)...`);

  const recentSystemPrompt = `You analyze iMessage conversations and extract items for "Me" (the user). Today is ${today}.

IMPORTANT: Each task should appear ONCE — either as a follow-up OR an action item, never both.
- Use ACTION ITEM for explicit commitments or direct requests ("I'll send that", "Can you call me?")
- Use FOLLOW-UP for softer nudges where no promise was made ("might want to check in", "birthday coming up")
- If in doubt, pick the one that fits best. Never create both for the same underlying task.

## 1. KEY EVENTS
Notable events, plans, or milestones mentioned in the conversation that are TODAY (${today}) or in the future.
Do NOT include events whose date has already passed.
Examples: "Dinner on Saturday night", "Maddy's birthday next week", "Trip to LA next month"

## 2. SUGGESTED FOLLOW-UPS
Softer suggestions for "Me" to follow up on something that is still relevant. These can reference a key event.
Do NOT create follow-ups for things tied to dates that have already passed.
Examples: "Wish Maddy happy birthday", "Check in with Mom after her appointment"

Create a follow-up when:
- A key event is coming up and "Me" might want to acknowledge it
- Someone shared news that warrants a check-in later
- The conversation trailed off and "Me" might want to re-engage

## 3. ACTION ITEMS
Explicit, concrete things "Me" has committed to or been directly asked to do that are still relevant.
Examples: "Send Mike the photos", "Book the restaurant for Friday"

Create an action item ONLY when:
- "Me" explicitly agreed or offered to do something ("I'll send you that", "Let me check")
- Someone made a direct, specific request ("Can you send me those photos?", "Call me")
- The item is still actionable — if it references a date or event that has already passed (before ${today}), do NOT include it

DO NOT create action items for:
- Conversations that ended naturally with no pending obligations
- Rhetorical questions or casual chat
- Things "Me" already handled later in the conversation
- Anything tied to a date that has already passed (e.g. "call me Tuesday" when Tuesday was last week)
- One-time verification codes, OTPs, 2FA codes, or login tokens (e.g. "Your code is 483291")

Each message is tagged with its database ID like [MSG-123]. Use this to identify the originating message.

You will be given the conversation AND any previously extracted items. Your response is the COMPLETE, authoritative list of what's still relevant. Items you omit will be removed. Include both new items and any previously extracted items that are still valid.

- If a previously extracted item is still relevant, include it in your response (you may update the title/date).
- If a previously extracted item has been resolved in the conversation or is no longer relevant, simply omit it.
- Do NOT include items the user has already marked as completed or removed (these are listed separately and excluded from your input).

Respond with ONLY valid JSON:
{
  "key_events": [
    { "message_id": 456, "title": "Dinner at Nobu on Saturday", "date": "2026-03-28T19:00:00Z" }
  ],
  "suggested_follow_ups": [
    { "message_id": 456, "title": "Confirm dinner reservation", "date": "2026-03-27T00:00:00Z", "key_event_index": 0 }
  ],
  "action_items": [
    { "message_id": 789, "title": "Send Mike the address", "date": null }
  ]
}

FIELD GUIDANCE:
- "message_id": The MSG-### ID of the originating message. Always include this.
- "title": Be specific. Include the person's name and what the item is about.
- "date": Based on conversation content, not arbitrary defaults.
  - If they say "dinner tomorrow" and today is ${today}, the date is tomorrow.
  - If they say "this weekend", use Saturday.
  - If they mention a specific date ("on the 25th", "March 30"), use that date.
  - If no timeframe is mentioned, use null.
- "key_event_index": Zero-based index into the key_events array in THIS response. Use this to link a follow-up to a key event you're creating in the same response. Use null if unrelated to a key event.
- If nothing to extract, return empty arrays for all fields.

No markdown fencing, no explanation.`;

  const olderSystemPrompt = `You analyze iMessage conversations and extract ONLY key events and related follow-ups. Today is ${today}.

This conversation is older than 2 weeks. Do NOT create action items — any commitments from this far back are either done or stale.
Only extract key events with FUTURE dates that "Me" (the user) might still want to be reminded about.

## 1. KEY EVENTS
Future-dated events, milestones, or recurring dates mentioned in the conversation.
Examples: "Maddy's birthday on April 5", "Trip to LA in May", "Baby due in June", "Wedding on July 12"

Only include events whose date is TODAY or later. Skip past events.

## 2. SUGGESTED FOLLOW-UPS
A follow-up tied to an upcoming key event — something "Me" might want to do before or on that date.
Examples: "Wish Maddy happy birthday", "Ask about LA trip plans", "Check in closer to the due date"

Each message is tagged with its database ID like [MSG-123]. Use this to identify the originating message.

Your response is the COMPLETE, authoritative list of what's still relevant. Items you omit will be removed.

Respond with ONLY valid JSON:
{
  "key_events": [
    { "message_id": 456, "title": "Maddy's birthday", "date": "2026-04-05T00:00:00Z" }
  ],
  "suggested_follow_ups": [
    { "message_id": 456, "title": "Wish Maddy happy birthday", "date": "2026-04-05T00:00:00Z", "key_event_index": 0 }
  ],
  "action_items": []
}

FIELD GUIDANCE:
- "message_id": The MSG-### ID of the originating message. Always include this.
- "title": Be specific. Include the person's name.
- "date": Must be a real date from the conversation, today (${today}) or later.
- "key_event_index": Zero-based index into the key_events array in THIS response.
- "action_items": Always return an empty array — do not create action items for old conversations.
- If nothing to extract, return empty arrays for all fields.

No markdown fencing, no explanation.`;

  let totalNew = 0;
  let totalCompleted = 0;

  // Process all chats: older ones first, then recent
  const allChats = [...olderChats, ...recentChats];
  for (let i = 0; i < allChats.length; i++) {
    const chat = allChats[i];
    const latestMsg = chat.messages[chat.messages.length - 1];
    const isRecent = latestMsg ? new Date(latestMsg.date) >= twoWeeksAgo : false;
    const systemPrompt = isRecent ? recentSystemPrompt : olderSystemPrompt;

    // Get existing active items for this chat — the LLM decides what to keep
    const existingEvents = await db.query(
      `SELECT id, title, date FROM key_events WHERE chat_id = $1 AND (removed = false OR removed IS NULL) ORDER BY created_at DESC`,
      [chat.chatId]
    );
    const existingFollowUps = await db.query(
      `SELECT id, title, date FROM suggested_follow_ups WHERE chat_id = $1 AND completed = false ORDER BY created_at DESC`,
      [chat.chatId]
    );
    const existingActionItems = await db.query(
      `SELECT id, title, date FROM action_items WHERE chat_id = $1 AND completed = false ORDER BY created_at DESC`,
      [chat.chatId]
    );

    // Get completed/removed items — these must NOT be recreated
    const removedEvents = await db.query(
      `SELECT title FROM key_events WHERE chat_id = $1 AND removed = true ORDER BY created_at DESC`,
      [chat.chatId]
    );
    const completedFollowUps = await db.query(
      `SELECT title FROM suggested_follow_ups WHERE chat_id = $1 AND completed = true ORDER BY created_at DESC`,
      [chat.chatId]
    );
    const completedActions = await db.query(
      `SELECT title FROM action_items WHERE chat_id = $1 AND completed = true ORDER BY created_at DESC`,
      [chat.chatId]
    );

    let existingBlock = '';
    const events = existingEvents.rows as { id: number; title: string; date: string | null }[];
    if (events.length > 0) {
      existingBlock += `\n\nPREVIOUSLY EXTRACTED KEY EVENTS (include in your response if still relevant, omit if not):\n${events.map((e) =>
        `- "${e.title}" (date: ${e.date ?? 'none'})`
      ).join('\n')}`;
    }

    const followUps = existingFollowUps.rows as { id: number; title: string; date: string | null }[];
    if (followUps.length > 0) {
      existingBlock += `\n\nPREVIOUSLY EXTRACTED FOLLOW-UPS (include in your response if still relevant, omit if not):\n${followUps.map((f) =>
        `- "${f.title}" (date: ${f.date ?? 'none'})`
      ).join('\n')}`;
    }

    const actionItems = existingActionItems.rows as { id: number; title: string; date: string | null }[];
    if (actionItems.length > 0) {
      existingBlock += `\n\nPREVIOUSLY EXTRACTED ACTION ITEMS (include in your response if still relevant, omit if not):\n${actionItems.map((a) =>
        `- "${a.title}" (date: ${a.date ?? 'none'})`
      ).join('\n')}`;
    }

    // Add completed/removed items so the LLM knows not to recreate them
    const doneItems: string[] = [];
    for (const r of removedEvents.rows as { title: string }[]) doneItems.push(r.title);
    for (const r of completedFollowUps.rows as { title: string }[]) doneItems.push(r.title);
    for (const r of completedActions.rows as { title: string }[]) doneItems.push(r.title);
    if (doneItems.length > 0) {
      existingBlock += `\n\nALREADY COMPLETED OR REMOVED BY USER (do NOT recreate these under any circumstances):\n${doneItems.map((t) =>
        `- "${t}"`
      ).join('\n')}`;
    }

    const msgLines = chat.messages.map((m) =>
      `[MSG-${m.id}] [${m.date}] ${m.sender}: ${m.text}`
    ).join('\n');

    try {
      const text = await callLLM(
        config,
        systemPrompt,
        `=== Chat ${chat.chatId}: "${chat.chatName}" ===\n${msgLines}${existingBlock}`,
        1024
      );
      const jsonStr = text.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
      // Try to extract JSON from the response even if there's extra text around it
      let jsonToParse = jsonStr;
      if (!jsonToParse.startsWith('{')) {
        const start = jsonToParse.indexOf('{');
        const end = jsonToParse.lastIndexOf('}');
        if (start !== -1 && end !== -1) {
          jsonToParse = jsonToParse.slice(start, end + 1);
        }
      }
      const parsed = JSON.parse(jsonToParse) as {
        key_events: { message_id: number; title: string; date: string | null }[];
        suggested_follow_ups: { message_id: number; title: string; date: string | null; key_event_index: number | null }[];
        action_items: { message_id: number; title: string; date: string | null }[];
      };

      // Delete existing active (non-completed, non-removed) items for this chat —
      // the LLM response is now the source of truth for what's still relevant.
      // User-completed and user-removed items are preserved.
      await db.query('DELETE FROM key_events WHERE chat_id = $1 AND (removed = false OR removed IS NULL)', [chat.chatId]);
      // Unlink follow-ups from deleted events before deleting
      await db.query('UPDATE suggested_follow_ups SET key_event_id = NULL WHERE chat_id = $1 AND completed = false', [chat.chatId]);
      await db.query('DELETE FROM suggested_follow_ups WHERE chat_id = $1 AND completed = false', [chat.chatId]);
      await db.query('DELETE FROM action_items WHERE chat_id = $1 AND completed = false', [chat.chatId]);

      // Insert fresh items from LLM response
      const newEventIds: number[] = [];
      for (const event of parsed.key_events) {
        const result = await db.query(
          `INSERT INTO key_events (chat_id, message_id, title, date) VALUES ($1, $2, $3, $4) RETURNING id`,
          [chat.chatId, event.message_id, event.title, event.date]
        );
        const newId = (result.rows[0] as { id: number }).id;
        newEventIds.push(newId);
        console.log(`  [events] ${i + 1}/${allChats.length} "${chat.chatName}" → ${event.title}`);
        totalNew++;
      }

      for (const followUp of parsed.suggested_follow_ups) {
        const keyEventId = followUp.key_event_index != null && followUp.key_event_index < newEventIds.length
          ? newEventIds[followUp.key_event_index]
          : null;

        await db.query(
          `INSERT INTO suggested_follow_ups (chat_id, message_id, title, date, key_event_id) VALUES ($1, $2, $3, $4, $5)`,
          [chat.chatId, followUp.message_id, followUp.title, followUp.date, keyEventId]
        );
        console.log(`  [follow-ups] ${i + 1}/${allChats.length} "${chat.chatName}" → ${followUp.title}`);
        totalNew++;
      }

      for (const action of parsed.action_items) {
        await db.query(
          `INSERT INTO action_items (chat_id, message_id, title, date) VALUES ($1, $2, $3, $4)`,
          [chat.chatId, action.message_id, action.title, action.date]
        );
        console.log(`  [action-items] ${i + 1}/${allChats.length} "${chat.chatName}" → ${action.title}`);
        totalNew++;
      }
    } catch (err) {
      const errMsg = (err as Error).message;
      if (errMsg.includes('JSON') || errMsg.includes('Unexpected')) {
        console.error(`  [actions] ${i + 1}/${allChats.length} "${chat.chatName}" ✗ JSON parse failed: ${errMsg}`);
      } else {
        console.error(`  [actions] ${i + 1}/${allChats.length} "${chat.chatName}" ✗ ${errMsg}`);
      }
    }
  }

  // Verify data actually persisted
  const verifyEvents = await db.query('SELECT count(*) as cnt FROM key_events');
  const verifyFollowUps = await db.query('SELECT count(*) as cnt FROM suggested_follow_ups WHERE completed = false');
  const verifyActions = await db.query('SELECT count(*) as cnt FROM action_items WHERE completed = false');
  console.log(`\n[actions] Added ${totalNew} new item(s), completed ${totalCompleted}.`);
  console.log(`[actions] DB verify — events: ${(verifyEvents.rows[0] as any).cnt}, follow-ups: ${(verifyFollowUps.rows[0] as any).cnt}, action items: ${(verifyActions.rows[0] as any).cnt}`);
  return totalNew;
}
