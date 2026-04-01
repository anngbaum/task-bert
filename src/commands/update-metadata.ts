import { getPglite } from '../db/pglite-client.js';
import { callLLM } from '../llm/query-parser.js';
import type { LLMConfig } from '../llm/query-parser.js';
import { updateSyncProgress } from '../progress.js';

/** Format a Date as a short local string like "Mon Mar 25, 8:36 PM" */
function localDate(d: Date): string {
  return d.toLocaleString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
  });
}

interface ChatMessage {
  id: number;
  sender: string;
  text: string;
  date: string;
  /** Raw ISO date for comparisons (localDate strips the year) */
  isoDate: string;
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

    // Get 50 most recent messages with sender info
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
       LIMIT 50`,
      [chatId]
    );

    const messages = (msgResult.rows as any[])
      .reverse() // chronological order
      .map((r) => ({
        id: r.id,
        sender: r.is_from_me ? 'Me' : r.sender,
        text: r.text,
        date: localDate(new Date(r.date)),
        isoDate: new Date(r.date).toISOString(),
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
  /** If true, skip action extraction entirely (caller will handle it) */
  skipActions?: boolean;
  /** If provided, only update metadata for these specific chat IDs */
  chatIds?: Set<number>;
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
        date: localDate(new Date(r.date)),
        isoDate: new Date(r.date).toISOString(),
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
  let chats = await getChatsWithNewMessages(effectiveSince, minMessages);

  // If caller specified specific chat IDs, filter the new-messages list to only those
  if (options.chatIds) {
    const before = chats.length;
    chats = chats.filter((c) => options.chatIds!.has(c.chatId));
    if (before !== chats.length) {
      console.log(`[metadata] Filtered to ${chats.length}/${before} chat(s) with new messages.`);
    }
  }

  // Always pick up chats that are missing metadata entirely (within the same window)
  // — these need summaries regardless of whether they had new messages in this sync
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

  const now = new Date();
  const today = now.toISOString().split('T')[0];
  const db = await getPglite();

  let totalSummaries = 0;

  if (chats.length === 0) {
    console.log('[metadata] No chats with new messages to summarize.');
  } else {
    console.log(`[metadata] Summarizing ${chats.length} chat(s)...`);

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
  }

  // Run action extraction on the same set of chats
  if (!options.skipActions && chats.length > 0) {
    await updateActions(config, chats);
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

  // Get 50 most recent messages (with id for action extraction)
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
     LIMIT 50`,
    [chatId]
  );

  const messages = (msgResult.rows as any[])
    .reverse()
    .map((r) => ({
      id: r.id,
      sender: r.is_from_me ? 'Me' : r.sender,
      text: r.text,
      date: localDate(new Date(r.date)),
      isoDate: new Date(r.date).toISOString(),
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

  // Also re-run action extraction for this chat only
  await updateActions(config, [{ chatId, chatName, messages }]);

  return summary;
}

export async function updateActions(config: LLMConfig, chats: ChatMessages[]): Promise<number> {
  const db = await getPglite();

  if (chats.length === 0) {
    console.log('[actions] No new messages to check for actions.');
    return 0;
  }

  const now = new Date();
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const todayDay = dayNames[now.getDay()];
  // Use local date (not UTC) so day-of-week and date are consistent
  const todayDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const today = `${todayDay}, ${todayDate}`;
  const twelveHoursAgo = localDate(new Date(now.getTime() - 12 * 60 * 60 * 1000));
  const twentyFourHoursAgo = localDate(new Date(now.getTime() - 24 * 60 * 60 * 1000));
  // Compute local timezone offset string (e.g., "-07:00", "+05:30") for LLM date guidance
  const tzOffsetMin = now.getTimezoneOffset();
  const tzSign = tzOffsetMin <= 0 ? '+' : '-';
  const tzHours = String(Math.floor(Math.abs(tzOffsetMin) / 60)).padStart(2, '0');
  const tzMins = String(Math.abs(tzOffsetMin) % 60).padStart(2, '0');
  const tzOffset = `${tzSign}${tzHours}:${tzMins}`;
  const twoWeeksAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);

  // Split chats into recent (≤2 weeks) and older (>2 weeks) based on latest message
  const recentChats: ChatMessages[] = [];
  const olderChats: ChatMessages[] = [];
  for (const chat of chats) {
    const latestMsg = chat.messages[chat.messages.length - 1];
    const latestDate = latestMsg ? new Date(latestMsg.isoDate) : new Date(0);
    if (latestDate >= twoWeeksAgo) {
      recentChats.push(chat);
    } else {
      olderChats.push(chat);
    }
  }

  console.log(`[actions] Checking ${chats.length} chat(s) — ${recentChats.length} recent, ${olderChats.length} older (events-only)...`);

  const recentSystemPrompt = `You analyze iMessage conversations and extract items for "Me" (the user). Today is ${today}.

## 1. KEY EVENTS
Notable events, plans, or milestones mentioned in the conversation that are TODAY (${today}) or in the future.
Do NOT include events whose date has already passed.
Examples: "Dinner on Saturday night at Nobu, 7pm", "Maddy's birthday next week", "Trip to LA next month"

If a previously extracted event has been updated with new details in the conversation (e.g., a time, location, or plan was confirmed), update the title and/or date to reflect the latest information. Be specific — include venue, time, and other confirmed details.

## 2. TASKS
Things "Me" should do, ranging from explicit commitments to softer follow-ups. Each task has a priority:

**high** — Explicit commitments or direct requests. "Me" agreed to do something or was directly asked.
Examples: "Send Mike the photos", "Book the restaurant for Friday", "Call Mom back"

**low** — Softer suggestions. No explicit promise was made, but "Me" might want to follow up.
Examples: "Check in with Sarah about her new job", "Wish Maddy happy birthday", "Follow up on weekend plans"

CRITICAL — Tasks are ONLY for things "Me" still needs to do. A task represents an action "Me" has NOT yet taken.
If "Me" already did something in the conversation (asked, responded, confirmed, sent, etc.), that is DONE — not a task.

Before creating any task, ask: "Did 'Me' already do this in the conversation?" If yes → no task.

Examples of things that are NOT tasks:
- "Me" asked Sara for a copy of the key → "Me" already asked. NOT a task. (It would only be a task if "Me" agreed to ask but hadn't yet.)
- "Me" said "That sounds good!" to a dinner plan → "Me" already responded. NOT a task.
- "Me" sent someone a link → "Me" already did it. NOT a task.

Create a task ONLY when:
- "Me" explicitly agreed or offered to do something AND has not done it yet in the conversation (high priority)
- Someone made a direct, specific request AND "Me" has not addressed it yet (high priority)
- Someone asked "Me" a specific question and "Me" has NOT responded anywhere later in the conversation. This is an unanswered question.
  - If the question was asked more than 24 hours ago (before ${twentyFourHoursAgo}): **high** priority — "Respond to [Name]'s question about [topic]"
  - If the question was asked more than 12 hours ago (before ${twelveHoursAgo}): **low** priority — "Respond to [Name]'s question about [topic]"
  - If the question was asked less than 12 hours ago: do not create a task yet.

DO NOT create tasks for:
- Things "Me" already did — if "Me" asked a question, sent a message, made a request, or took any action in the conversation, that action is COMPLETE. Do not create a task telling "Me" to do something they already did.
- Answered questions — if someone asked "Me" something and "Me" responded ANYWHERE later (even briefly like "sounds good" or "yes"), it is resolved.
- Confirmed plans — if a plan was proposed and agreed to, create a key_event, not a task.
- Conversations that ended naturally with no pending obligations
- Rhetorical questions or casual greetings (e.g. "lol", "haha", "nice")
- Anything tied to a date that has already passed (before ${today})
- One-time verification codes, OTPs, 2FA codes, or login tokens
- Speculative follow-ups — do NOT create tasks suggesting "Me" should ask about details, check in, or follow up unless there is a clear unresolved obligation

Each task should appear ONCE. Never create duplicate tasks for the same underlying thing.

Each message is tagged with its database ID like [MSG-123]. Use this to identify the originating message.

Your response is the COMPLETE, authoritative list of what's still relevant. Items you omit will be removed. Include both new items and any previously extracted items that are still valid.

- If a previously extracted item is still relevant, include it in your response (you may update the title/date/priority).
- If a previously extracted item has been resolved in the conversation or is no longer relevant, simply omit it.
- If the conversation has moved on to a new topic and a low-priority task like "check in about X" is stale, omit it.
- Do NOT include items the user has already marked as completed or removed.

Respond with ONLY valid JSON:
{
  "key_events": [
    { "message_id": 456, "title": "Dinner on Saturday", "date": "2026-03-28T19:00:00${tzOffset}", "location": "Nobu Malibu" }
  ],
  "tasks": [
    { "message_id": 789, "title": "Send Mike the address", "date": null, "priority": "high", "key_event_index": null },
    { "message_id": 456, "title": "Confirm dinner reservation", "date": "2026-03-27T12:00:00${tzOffset}", "priority": "low", "key_event_index": 0 }
  ]
}

FIELD GUIDANCE:
- "message_id": The MSG-### ID of the originating message. Always include this.
- "title": Be specific. Include the person's name and what the item is about.
- "priority": "high" for explicit commitments/requests, "low" for softer follow-ups.
- "date": Based on conversation content, not arbitrary defaults. IMPORTANT: Use the local timezone offset ${tzOffset} (NOT "Z"/UTC) so dates display correctly. For all-day events, use noon local time: "${todayDate}T12:00:00${tzOffset}".
  - If they say "dinner tomorrow" and today is ${today}, the date is tomorrow.
  - If they say "this weekend", use Saturday.
  - If they mention a specific date ("on the 25th", "March 30"), use that date.
  - If a specific time is mentioned (e.g. "7pm"), use that time with the local offset: "2026-03-28T19:00:00${tzOffset}".
  - If no timeframe is mentioned, use null.
- "location": For key events, the venue or place if mentioned (e.g. "Nobu Malibu", "Central Park"). Use null if not mentioned.
- "key_event_index": Zero-based index into the key_events array in THIS response. Use to link a task to an event. Use null if unrelated.
- If nothing to extract, return empty arrays for all fields.

No markdown fencing, no explanation.`;

  const olderSystemPrompt = `You analyze iMessage conversations and extract ONLY key events and related follow-ups. Today is ${today}.

This conversation is older than 2 weeks. Do NOT create action items — any commitments from this far back are either done or stale.
Only extract key events with FUTURE dates that "Me" (the user) might still want to be reminded about.

## 1. KEY EVENTS
Future-dated events, milestones, or recurring dates mentioned in the conversation.
Examples: "Maddy's birthday on April 5", "Trip to LA in May", "Baby due in June", "Wedding on July 12"

Only include events whose date is TODAY (${today}) or later. Skip past events.

## 2. TASKS
Low-priority tasks tied to upcoming key events — things "Me" might want to do before or on that date.
Examples: "Wish Maddy happy birthday", "Ask about LA trip plans", "Check in closer to the due date"

Each message is tagged with its database ID like [MSG-123]. Use this to identify the originating message.

Your response is the COMPLETE, authoritative list of what's still relevant. Items you omit will be removed.

Respond with ONLY valid JSON:
{
  "key_events": [
    { "message_id": 456, "title": "Maddy's birthday", "date": "2026-04-05T12:00:00${tzOffset}", "location": null }
  ],
  "tasks": [
    { "message_id": 456, "title": "Wish Maddy happy birthday", "date": "2026-04-05T12:00:00${tzOffset}", "priority": "low", "key_event_index": 0 }
  ]
}

FIELD GUIDANCE:
- "message_id": The MSG-### ID of the originating message. Always include this.
- "title": Be specific. Include the person's name.
- "priority": Always "low" for old conversations — do not create high-priority tasks.
- "date": Must be a real date from the conversation, today (${today}) or later. Use local timezone offset ${tzOffset} (NOT "Z"/UTC). For all-day events use noon: "YYYY-MM-DDT12:00:00${tzOffset}".
- "key_event_index": Zero-based index into the key_events array in THIS response.
- If nothing to extract, return empty arrays for all fields.

No markdown fencing, no explanation.`;

  let totalNew = 0;
  let totalCompleted = 0;

  // Process all chats: older ones first, then recent
  const allChats = [...olderChats, ...recentChats];
  for (let i = 0; i < allChats.length; i++) {
    const chat = allChats[i];
    const latestMsg = chat.messages[chat.messages.length - 1];
    const isRecent = latestMsg ? new Date(latestMsg.isoDate) >= twoWeeksAgo : false;
    const systemPrompt = isRecent ? recentSystemPrompt : olderSystemPrompt;

    // Get existing active items for this chat — the LLM decides what to keep
    const existingEvents = await db.query(
      `SELECT id, title, date, location FROM key_events WHERE chat_id = $1 AND (removed = false OR removed IS NULL) ORDER BY created_at DESC`,
      [chat.chatId]
    );
    const existingTasks = await db.query(
      `SELECT id, title, date, priority FROM tasks WHERE chat_id = $1 AND completed = false ORDER BY created_at DESC`,
      [chat.chatId]
    );

    // Get completed/removed items — these must NOT be recreated
    const removedEvents = await db.query(
      `SELECT title FROM key_events WHERE chat_id = $1 AND removed = true ORDER BY created_at DESC`,
      [chat.chatId]
    );
    const completedTasks = await db.query(
      `SELECT title FROM tasks WHERE chat_id = $1 AND completed = true ORDER BY created_at DESC`,
      [chat.chatId]
    );

    let existingBlock = '';
    const events = existingEvents.rows as { id: number; title: string; date: string | null; location: string | null }[];
    if (events.length > 0) {
      existingBlock += `\n\nPREVIOUSLY EXTRACTED KEY EVENTS (include if still relevant — update title/date/location if the conversation has new details, omit if past or irrelevant):\n${events.map((e) =>
        `- "${e.title}" (date: ${e.date ?? 'none'}, location: ${e.location ?? 'none'})`
      ).join('\n')}`;
    }

    const tasks = existingTasks.rows as { id: number; title: string; date: string | null; priority: string }[];
    if (tasks.length > 0) {
      existingBlock += `\n\nPREVIOUSLY EXTRACTED TASKS (include if still pending — omit if the conversation shows it was completed, resolved, or is no longer relevant):\n${tasks.map((t) =>
        `- [${t.priority}] "${t.title}" (date: ${t.date ?? 'none'})`
      ).join('\n')}`;
    }

    // Add completed/removed items so the LLM knows not to recreate them
    const doneItems: string[] = [];
    for (const r of removedEvents.rows as { title: string }[]) doneItems.push(r.title);
    for (const r of completedTasks.rows as { title: string }[]) doneItems.push(r.title);
    if (doneItems.length > 0) {
      existingBlock += `\n\nALREADY COMPLETED OR REMOVED BY USER (do NOT recreate these under any circumstances):\n${doneItems.map((t) =>
        `- "${t}"`
      ).join('\n')}`;
    }

    const msgLines = chat.messages.map((m) =>
      `[MSG-${m.id}] [${m.date}] ${m.sender}: ${m.text}`
    ).join('\n');

    try {
      // Use a smarter model for action extraction — pick based on available API keys
      const actionsModel = config.anthropicApiKey
        ? 'claude-sonnet-4-5-20250514'
        : 'gpt-4o';
      const text = await callLLM(
        config,
        systemPrompt,
        `=== Chat with ${chat.chatName} ===\nMessages labeled "Me" are from the user. Messages labeled with other names are from contacts.\n\n${msgLines}${existingBlock}`,
        1024,
        actionsModel
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
        key_events: { message_id: number; title: string; date: string | null; location: string | null }[];
        tasks: { message_id: number; title: string; date: string | null; priority: string; key_event_index: number | null }[];
      };

      // Delete existing active (non-completed, non-removed) items for this chat —
      // the LLM response is now the source of truth for what's still relevant.
      // User-completed and user-removed items are preserved.
      // Preserve reminder_id mappings so synced Reminders survive resync.
      const reminderMap = new Map<string, string>();
      const existingTasks = await db.query(
        'SELECT title, reminder_id FROM tasks WHERE chat_id = $1 AND reminder_id IS NOT NULL',
        [chat.chatId]
      );
      for (const row of existingTasks.rows as { title: string; reminder_id: string }[]) {
        reminderMap.set(row.title, row.reminder_id);
      }

      await db.query('UPDATE tasks SET key_event_id = NULL WHERE chat_id = $1', [chat.chatId]);
      await db.query('DELETE FROM key_events WHERE chat_id = $1 AND (removed = false OR removed IS NULL)', [chat.chatId]);
      await db.query('DELETE FROM tasks WHERE chat_id = $1 AND completed = false', [chat.chatId]);

      // Insert fresh items from LLM response
      const newEventIds: number[] = [];
      for (const event of parsed.key_events) {
        const result = await db.query(
          `INSERT INTO key_events (chat_id, message_id, title, date, location) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
          [chat.chatId, event.message_id, event.title, event.date, event.location ?? null]
        );
        const newId = (result.rows[0] as { id: number }).id;
        newEventIds.push(newId);
        console.log(`  [events] ${i + 1}/${allChats.length} "${chat.chatName}" → ${event.title}`);
        totalNew++;
      }

      for (const task of (parsed.tasks ?? [])) {
        const priority = task.priority === 'high' ? 'high' : 'low';
        const keyEventId = task.key_event_index != null && task.key_event_index < newEventIds.length
          ? newEventIds[task.key_event_index]
          : null;

        const restoredReminderId = reminderMap.get(task.title) ?? null;
        await db.query(
          `INSERT INTO tasks (chat_id, message_id, title, date, priority, key_event_id, reminder_id) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [chat.chatId, task.message_id, task.title, task.date, priority, keyEventId, restoredReminderId]
        );
        console.log(`  [tasks] ${i + 1}/${allChats.length} "${chat.chatName}" → [${priority}] ${task.title}`);
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
  const verifyEvents = await db.query('SELECT count(*) as cnt FROM key_events WHERE (removed = false OR removed IS NULL)');
  const verifyTasks = await db.query('SELECT count(*) as cnt FROM tasks WHERE completed = false');
  console.log(`\n[actions] Added ${totalNew} new item(s).`);
  console.log(`[actions] DB verify — events: ${(verifyEvents.rows[0] as any).cnt}, tasks: ${(verifyTasks.rows[0] as any).cnt}`);
  return totalNew;
}
