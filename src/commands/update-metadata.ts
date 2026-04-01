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
    const SUMMARY_CONCURRENCY = 5;
    let completed = 0;

    for (let batchStart = 0; batchStart < chats.length; batchStart += SUMMARY_CONCURRENCY) {
      const batch = chats.slice(batchStart, batchStart + SUMMARY_CONCURRENCY);
      updateSyncProgress('metadata', `Summarizing chats ${batchStart + 1}–${Math.min(batchStart + SUMMARY_CONCURRENCY, chats.length)} of ${chats.length}...`, 85 + Math.round((batchStart / chats.length) * 12));

      const results = await Promise.allSettled(batch.map(async (chat, j) => {
        const i = batchStart + j;
        console.log(`  [metadata] ${i + 1}/${chats.length}: "${chat.chatName}"...`);

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

        return { chat, summary };
      }));

      for (const result of results) {
        if (result.status === 'fulfilled') {
          const { chat, summary } = result.value;
          await db.query(
            `INSERT INTO chat_metadata (chat_id, summary, last_updated)
             VALUES ($1, $2, $3)
             ON CONFLICT (chat_id) DO UPDATE SET summary = $2, last_updated = $3`,
            [chat.chatId, summary, now.toISOString()]
          );
          totalSummaries++;
          completed++;
          console.log(`    → ${summary.slice(0, 100)}${summary.length > 100 ? '...' : ''}`);
        } else {
          completed++;
          console.error(`    ✗ Failed: ${(result.reason as Error).message}`);
        }
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

/** Helper to parse JSON from LLM response, tolerating markdown fences and surrounding text. */
function parseJSON<T>(text: string): T {
  const cleaned = text.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
  let toParse = cleaned;
  if (!toParse.startsWith('{') && !toParse.startsWith('[')) {
    const start = toParse.indexOf('{');
    const end = toParse.lastIndexOf('}');
    if (start !== -1 && end !== -1) toParse = toParse.slice(start, end + 1);
  }
  try {
    return JSON.parse(toParse);
  } catch {
    // LLM may return trailing text after valid JSON — find the balanced closing brace
    const start = toParse.indexOf('{');
    if (start !== -1) {
      let depth = 0;
      for (let i = start; i < toParse.length; i++) {
        if (toParse[i] === '{') depth++;
        else if (toParse[i] === '}') depth--;
        if (depth === 0) {
          return JSON.parse(toParse.slice(start, i + 1));
        }
      }
    }
    throw new Error(`JSON parse failed: ${toParse.slice(0, 200)}`);
  }
}

/** Call LLM and parse JSON response, retrying on parse or transient failures. */
async function callLLMJSON<T>(
  config: LLMConfig,
  systemPrompt: string,
  userPrompt: string,
  maxTokens: number,
  model: string,
  retries = 2,
): Promise<T> {
  let lastError: Error | undefined;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const text = await callLLM(config, systemPrompt, userPrompt, maxTokens, model);
      return parseJSON<T>(text);
    } catch (err) {
      lastError = err as Error;
      if (attempt < retries) {
        const delay = 1000 * (attempt + 1);
        console.warn(`  [retry] Attempt ${attempt + 1} failed (${lastError.message}), retrying in ${delay}ms...`);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw lastError!;
}

/** Shared date/time context for prompts. */
function buildTimeContext() {
  const now = new Date();
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const todayDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const today = `${dayNames[now.getDay()]}, ${todayDate}`;
  const tzOffsetMin = now.getTimezoneOffset();
  const tzSign = tzOffsetMin <= 0 ? '+' : '-';
  const tzHours = String(Math.floor(Math.abs(tzOffsetMin) / 60)).padStart(2, '0');
  const tzMins = String(Math.abs(tzOffsetMin) % 60).padStart(2, '0');
  const tzOffset = `${tzSign}${tzHours}:${tzMins}`;
  const twelveHoursAgo = localDate(new Date(now.getTime() - 12 * 60 * 60 * 1000));
  const twentyFourHoursAgo = localDate(new Date(now.getTime() - 24 * 60 * 60 * 1000));
  const twoWeeksAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);
  return { now, today, todayDate, tzOffset, twelveHoursAgo, twentyFourHoursAgo, twoWeeksAgo };
}

/** Extract key events from a single chat. */
async function extractEvents(
  config: LLMConfig,
  chat: ChatMessages,
  index: number,
  total: number,
  ctx: ReturnType<typeof buildTimeContext>,
): Promise<{ message_id: number; title: string; date: string | null; location: string | null }[]> {
  const db = await getPglite();

  const existingEvents = (await db.query(
    `SELECT title, date, location FROM key_events WHERE chat_id = $1 AND (removed = false OR removed IS NULL) ORDER BY created_at DESC`,
    [chat.chatId]
  )).rows as { title: string; date: string | null; location: string | null }[];

  const removedEvents = (await db.query(
    `SELECT title FROM key_events WHERE chat_id = $1 AND removed = true ORDER BY created_at DESC`,
    [chat.chatId]
  )).rows as { title: string }[];

  let existingBlock = '';
  if (existingEvents.length > 0) {
    existingBlock += `\n\nPREVIOUSLY EXTRACTED (include if still relevant, update if new details, omit if past):\n${existingEvents.map((e) =>
      `- "${e.title}" (date: ${e.date ?? 'none'}, location: ${e.location ?? 'none'})`
    ).join('\n')}`;
  }
  if (removedEvents.length > 0) {
    existingBlock += `\n\nREMOVED BY USER (do NOT recreate):\n${removedEvents.map((e) => `- "${e.title}"`).join('\n')}`;
  }

  const msgLines = chat.messages.map((m) => `[MSG-${m.id}] [${m.date}] ${m.sender}: ${m.text}`).join('\n');

  const systemPrompt = `Extract future events from this iMessage conversation. Today is ${ctx.today}.

Return events/plans/milestones with dates TODAY or later. Skip past events.
Be specific — include venue, time, and confirmed details.
Each message is tagged [MSG-###]. Use message_id to identify the source.

Your response is the COMPLETE list. Items you omit will be removed.

Respond with ONLY valid JSON:
{ "events": [{ "message_id": 456, "title": "Dinner at Nobu", "date": "2026-04-05T19:00:00${ctx.tzOffset}", "location": "Nobu Malibu" }] }

DATES: Use timezone ${ctx.tzOffset} (not UTC "Z"). All-day events use noon: "YYYY-MM-DDT12:00:00${ctx.tzOffset}". Empty list if nothing to extract. No markdown fencing.`;

  const actionsModel = config.actionsModel ?? (config.anthropicApiKey ? 'claude-sonnet-4-6' : 'gpt-4o');
  const parsed = await callLLMJSON<{ events: { message_id: number; title: string; date: string | null; location: string | null }[] }>(
    config,
    systemPrompt,
    `=== Chat with ${chat.chatName} ===\n${msgLines}${existingBlock}`,
    512,
    actionsModel
  );

  // Hard filter: drop any events the LLM returned with past dates
  const todayStart = new Date(`${ctx.todayDate}T00:00:00`);
  const futureEvents = parsed.events.filter((e) => {
    if (!e.date) return false; // events must have a date
    const eventDate = new Date(e.date);
    return !isNaN(eventDate.getTime()) && eventDate >= todayStart;
  });

  for (const event of futureEvents) {
    console.log(`  [events] ${index + 1}/${total} "${chat.chatName}" → ${event.title}`);
  }
  return futureEvents;
}

/** Extract tasks from a single recent chat. */
async function extractTasks(
  config: LLMConfig,
  chat: ChatMessages,
  index: number,
  total: number,
  ctx: ReturnType<typeof buildTimeContext>,
): Promise<{ message_id: number; title: string; date: string | null; priority: string; type: string; trigger_hint: string | null }[]> {
  const db = await getPglite();

  const existingTasks = (await db.query(
    `SELECT title, date, priority, type, trigger_hint FROM tasks WHERE chat_id = $1 AND completed = false ORDER BY created_at DESC`,
    [chat.chatId]
  )).rows as { title: string; date: string | null; priority: string; type: string; trigger_hint: string | null }[];

  const completedTasks = (await db.query(
    `SELECT title FROM tasks WHERE chat_id = $1 AND completed = true ORDER BY created_at DESC`,
    [chat.chatId]
  )).rows as { title: string }[];

  let existingBlock = '';
  if (existingTasks.length > 0) {
    existingBlock += `\n\nPREVIOUSLY EXTRACTED (include if still pending, omit if resolved):\n${existingTasks.map((t) =>
      `- [${t.type}/${t.priority}] "${t.title}" (date: ${t.date ?? 'none'}, trigger: ${t.trigger_hint ?? 'none'})`
    ).join('\n')}`;
  }
  if (completedTasks.length > 0) {
    existingBlock += `\n\nCOMPLETED BY USER (do NOT recreate):\n${completedTasks.map((t) => `- "${t.title}"`).join('\n')}`;
  }

  const msgLines = chat.messages.map((m) => `[MSG-${m.id}] [${m.date}] ${m.sender}: ${m.text}`).join('\n');

  const systemPrompt = `Extract tasks for "Me" (the user) from this iMessage conversation. Today is ${ctx.today}.

Only create tasks where Me has a clear obligation or someone is clearly waiting on Me. When in doubt, don't create a task.

## WHAT TO EXTRACT

1. **Unanswered questions** — Someone asked Me a direct question and Me has NOT replied later in the conversation.
   - Asked before ${ctx.twentyFourHoursAgo} → type: "action", priority: "high"
   - Asked before ${ctx.twelveHoursAgo} → type: "action", priority: "low"
   - Asked less than 12h ago → skip (too soon)

2. **Unfulfilled commitments** — Me explicitly agreed or offered to do something and hasn't done it yet.
   → type: "action", priority: "high"

3. **Unaddressed requests** — Someone directly asked Me to do something specific and Me hasn't addressed it.
   → type: "action", priority: "high"

4. **Waiting on others** — Me asked a question or made a request and is waiting for their reply.
   → type: "waiting"

5. **Concrete future follow-ups** — Me and someone made a specific plan to do something in the future (e.g. "let's do a bakery crawl this spring", "we should get dinner when you're in town"). These MUST have a date — estimate from context (e.g. "this spring" → late April, "next month" → mid next month). If you can't estimate a reasonable date, don't create the task.
   → type: "action", priority: "low", date: estimated future date, trigger_hint: what would make it relevant

## WHAT IS NOT A TASK

- A general ask in a group chat that is not directed at Me
- Something Me already did in the conversation (asked, replied, sent, confirmed)
- A confirmed plan with no remaining action for Me
- Vague ideas with no commitment ("that would be fun", "we should sometime")
- Rhetorical questions, greetings, casual banter
- Verification codes, OTPs, spam
- Venmo requests or automated payment notifications
- Anything with a date before ${ctx.today}

## OUTPUT

Each message is tagged [MSG-###]. Your response is the COMPLETE list — items you omit will be removed.

Respond with ONLY valid JSON:
{ "tasks": [{ "message_id": 789, "title": "Respond to Grady's question about AI", "date": null, "type": "action", "priority": "high", "trigger_hint": null }] }

FIELDS:
- title: Be specific. Include the person's name and topic.
- type: "action" (Me needs to act) or "waiting" (someone else needs to act first)
- priority: "high" (explicit commitment/request) or "low" (softer follow-up)
- date: Due date or activation date. Use timezone ${ctx.tzOffset} (not UTC). null if no deadline. Future follow-ups MUST have a date.
- trigger_hint: What event would make a future task relevant sooner. null if not applicable.
Empty list if nothing to extract. No markdown fencing.`;

  const actionsModel = config.actionsModel ?? (config.anthropicApiKey ? 'claude-sonnet-4-6' : 'gpt-4o');
  const parsed = await callLLMJSON<{ tasks: { message_id: number; title: string; date: string | null; priority: string; type: string; trigger_hint: string | null }[] }>(
    config,
    systemPrompt,
    `=== Chat with ${chat.chatName} ===\nMessages labeled "Me" are from the user. Messages labeled with other names are from contacts.\n\n${msgLines}${existingBlock}`,
    512,
    actionsModel
  );
  for (const task of parsed.tasks) {
    const type = task.type === 'waiting' ? 'waiting' : 'action';
    const priority = task.priority === 'high' ? 'high' : 'low';
    console.log(`  [tasks] ${index + 1}/${total} "${chat.chatName}" → [${type}/${priority}] ${task.title}`);
  }
  return parsed.tasks;
}

export async function updateActions(config: LLMConfig, chats: ChatMessages[]): Promise<number> {
  const db = await getPglite();

  if (chats.length === 0) {
    console.log('[actions] No new messages to check for actions.');
    return 0;
  }

  const ctx = buildTimeContext();

  // Split chats into recent (≤2 weeks) and older (>2 weeks) based on latest message
  const recentChats: ChatMessages[] = [];
  const olderChats: ChatMessages[] = [];
  for (const chat of chats) {
    const latestMsg = chat.messages[chat.messages.length - 1];
    const latestDate = latestMsg ? new Date(latestMsg.isoDate) : new Date(0);
    if (latestDate >= ctx.twoWeeksAgo) {
      recentChats.push(chat);
    } else {
      olderChats.push(chat);
    }
  }

  console.log(`[actions] Checking ${chats.length} chat(s) — ${recentChats.length} recent, ${olderChats.length} older (events-only)...`);

  let totalNew = 0;
  const allChats = [...olderChats, ...recentChats];
  const CONCURRENCY = 5;

  // Process chats in parallel batches
  for (let batchStart = 0; batchStart < allChats.length; batchStart += CONCURRENCY) {
    const batch = allChats.slice(batchStart, batchStart + CONCURRENCY);

    // Pre-fetch reminder mappings for this batch (DB reads before parallel LLM calls)
    const batchContext = await Promise.all(batch.map(async (chat, j) => {
      const i = batchStart + j;
      const latestMsg = chat.messages[chat.messages.length - 1];
      const isRecent = latestMsg ? new Date(latestMsg.isoDate) >= ctx.twoWeeksAgo : false;

      const reminderMap = new Map<string, string>();
      const reminderRows = await db.query(
        'SELECT title, reminder_id FROM tasks WHERE chat_id = $1 AND reminder_id IS NOT NULL',
        [chat.chatId]
      );
      for (const row of reminderRows.rows as { title: string; reminder_id: string }[]) {
        reminderMap.set(row.title, row.reminder_id);
      }

      // Clear active items — LLM response becomes source of truth
      await db.query('DELETE FROM key_events WHERE chat_id = $1 AND (removed = false OR removed IS NULL)', [chat.chatId]);
      if (isRecent) {
        await db.query('DELETE FROM tasks WHERE chat_id = $1 AND completed = false', [chat.chatId]);
      }

      return { chat, i, isRecent, reminderMap };
    }));

    // Run LLM extraction in parallel
    const batchResults = await Promise.allSettled(batchContext.map(async ({ chat, i, isRecent }) => {
      const events = await extractEvents(config, chat, i, allChats.length, ctx);
      const tasks = isRecent ? await extractTasks(config, chat, i, allChats.length, ctx) : [];
      return { events, tasks };
    }));

    // Write results to DB sequentially
    for (let j = 0; j < batch.length; j++) {
      const { chat, i, isRecent, reminderMap } = batchContext[j];
      const result = batchResults[j];

      if (result.status === 'rejected') {
        const errMsg = (result.reason as Error).message;
        if (errMsg.includes('JSON') || errMsg.includes('Unexpected')) {
          console.error(`  [actions] ${i + 1}/${allChats.length} "${chat.chatName}" ✗ JSON parse failed: ${errMsg}`);
        } else {
          console.error(`  [actions] ${i + 1}/${allChats.length} "${chat.chatName}" ✗ ${errMsg}`);
        }
        continue;
      }

      const { events, tasks } = result.value;

      for (const event of events) {
        await db.query(
          `INSERT INTO key_events (chat_id, message_id, title, date, location) VALUES ($1, $2, $3, $4, $5)`,
          [chat.chatId, event.message_id, event.title, event.date, event.location?.trim() || null]
        );
        totalNew++;
      }

      if (isRecent) {
        for (const task of tasks) {
          const priority = task.priority === 'high' ? 'high' : 'low';
          const type = task.type === 'waiting' ? 'waiting' : 'action';
          const restoredReminderId = reminderMap.get(task.title) ?? null;
          await db.query(
            `INSERT INTO tasks (chat_id, message_id, title, date, priority, type, trigger_hint, reminder_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [chat.chatId, task.message_id, task.title, task.date, priority, type, task.trigger_hint ?? null, restoredReminderId]
          );
          totalNew++;
        }
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
