import { searchFTS } from '../search/fts.js';
import { searchVector } from '../search/vector.js';
import { searchHybrid } from '../search/hybrid.js';
import { getContextMessages } from '../display/formatter.js';
import { searchContacts } from '../contacts/search.js';
import { getPglite } from '../db/pglite-client.js';
import { callLLM, getModelProvider, type LLMConfig } from '../llm/query-parser.js';
import type { SearchOptions, SearchResult, ContextMessage } from '../types.js';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';

// --- Tool definitions ---

const TOOLS = [
  {
    name: 'search_messages',
    description: `Search through iMessage history. Returns matching messages with sender, date, chat name, and message ID. Each result includes 2 messages before and after for conversational context.

IMPORTANT TIPS:
- When looking for info about/from a person, ALWAYS use "with_contact" to search within their conversation. This finds ALL messages (both sent and received) in chats with that person.
- Start with short queries (1-3 keywords). Long queries often return nothing.
- If 0 results: try (1) different/broader keywords, (2) "text" mode for exact words, (3) "semantic" mode for meaning-based matching, (4) remove filters and search broadly.
- Use resolve_contact first to find the exact name before using with_contact.
- Each result shows surrounding messages for context — read them carefully, the answer is often in a nearby message rather than the matched one.`,
    parameters: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'The search query — topic keywords to search for. Keep it short and focused (1-3 words work best).' },
        mode: { type: 'string', enum: ['text', 'semantic', 'hybrid'], description: 'Search mode. "text" for exact keyword matching, "semantic" for meaning-based search, "hybrid" for best of both. Default: hybrid. Try "text" if hybrid returns nothing.' },
        with_contact: { type: 'string', description: 'Filter to messages in conversations WITH this person (both sent and received). This is the primary way to search a specific person\'s conversation.' },
        after: { type: 'string', description: 'ISO date string — only messages after this date. Only use if the user specifies a time range.' },
        before: { type: 'string', description: 'ISO date string — only messages before this date. Only use if the user specifies a time range.' },
        from_me: { type: 'boolean', description: 'If true, only show messages I sent' },
        group_chat: { type: 'string', description: 'Filter to a specific group chat by name' },
        limit: { type: 'number', description: 'Max results to return (default 10, max 30)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_context',
    description: `Get a wider window of surrounding messages for a specific message ID. Returns more context than what's included in search results.

USE THIS WHEN:
- A search result looks relevant but the inline context (2 before, 5 after) isn't enough to find the answer
- You see a question in the context but the answer was sent later and isn't visible yet
- You want to read more of the conversation to understand the full picture
- The information you need might be a few messages away from the match

You can call this multiple times with increasing "after" values (e.g. 10, then 20) to keep reading further into the conversation.`,
    parameters: {
      type: 'object' as const,
      properties: {
        message_id: { type: 'number', description: 'The message ID to get context around' },
        before: { type: 'number', description: 'Number of messages before (default 5, max 50)' },
        after: { type: 'number', description: 'Number of messages after (default 10, max 50). Increase this if you think the answer came later in the conversation.' },
      },
      required: ['message_id'],
    },
  },
  {
    name: 'resolve_contact',
    description: 'Look up a contact by name to find their exact name as stored in the database and their message count. ALWAYS call this first before using "with_contact" in search_messages — the name must match exactly what\'s in the database.',
    parameters: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'The person\'s name to look up' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_chat_summaries',
    description: 'Get AI-generated summaries of recent conversations. Useful for getting an overview of what\'s been discussed recently across all chats, or finding which conversation to search in.',
    parameters: {
      type: 'object' as const,
      properties: {
        limit: { type: 'number', description: 'Max number of summaries (default 10)' },
      },
    },
  },
];

// --- Tool execution ---

async function executeSearch(args: Record<string, unknown>): Promise<{ results: SearchResult[]; resultsWithContext: { result: SearchResult; context: ContextMessage[] }[]; total: number }> {
  const query = args.query as string;
  const mode = (args.mode as string) || 'hybrid';
  const limit = Math.min((args.limit as number) || 10, 30);

  const options: SearchOptions = {
    mode: mode as SearchOptions['mode'],
    limit,
    offset: 0,
    context: 0,
  };

  // with_contact: filter to conversations WITH this person (both sent and received)
  if (args.with_contact) {
    const contactName = args.with_contact as string;
    const matches = await searchContacts(contactName, 5);
    console.log(`[agent] resolve with_contact "${contactName}": ${matches.length} matches → ${matches.map(m => `${m.displayName ?? m.identifier} (score: ${m.score}, msgs: ${m.messageCount})`).join(', ')}`);
    if (matches.length > 0) {
      options.withContacts = [matches[0].displayName ?? matches[0].identifier];
    } else {
      options.withContacts = [contactName];
    }
  }

  if (args.after) options.after = args.after as string;
  if (args.before) options.before = args.before as string;
  if (args.from_me) options.fromMe = true;
  if (args.group_chat) options.groupChatName = args.group_chat as string;

  console.log(`[agent] search: query="${query}" mode=${mode} limit=${limit} filters=${JSON.stringify({
    withContacts: options.withContacts, handleIds: options.handleIds, from: options.from,
    after: options.after, before: options.before, fromMe: options.fromMe, groupChatName: options.groupChatName
  })}`);

  let results: SearchResult[];
  switch (mode) {
    case 'text':
      results = await searchFTS(query, options);
      break;
    case 'semantic':
      results = await searchVector(query, options);
      break;
    case 'hybrid':
    default:
      results = await searchHybrid(query, options);
      break;
  }

  // Fetch surrounding context (2 before, 5 after) for each result so the LLM
  // can understand messages in their conversational context.
  // More "after" messages because answers often come several messages after the question.
  const resultsWithContext: { result: SearchResult; context: ContextMessage[] }[] = [];
  for (const r of results) {
    const ctx = await getContextMessages(r.id, 2, 5);
    resultsWithContext.push({ result: r, context: ctx });
  }

  console.log(`[agent] search returned ${results.length} results (with context)`);
  return { results, resultsWithContext, total: results.length };
}

async function executeGetContext(args: Record<string, unknown>): Promise<ContextMessage[]> {
  const messageId = args.message_id as number;
  const before = (args.before as number) || 5;
  const after = (args.after as number) || 10;
  return getContextMessages(messageId, before, after);
}

async function executeResolveContact(args: Record<string, unknown>): Promise<unknown> {
  const name = args.name as string;
  const matches = await searchContacts(name, 5);
  return matches.map(m => ({
    name: m.displayName ?? m.identifier,
    identifier: m.identifier,
    message_count: m.messageCount,
    score: m.score,
  }));
}

async function executeGetChatSummaries(args: Record<string, unknown>): Promise<unknown> {
  const limit = Math.min((args.limit as number) || 10, 25);
  const db = await getPglite();
  const result = await db.query(
    `SELECT cm.chat_id, cm.summary,
            CASE
              WHEN c.display_name IS NOT NULL AND c.display_name != '' THEN c.display_name
              ELSE (
                SELECT COALESCE(_h2.display_name, _h2.identifier)
                FROM chat_handle_join _chj3
                JOIN handle _h2 ON _chj3.handle_id = _h2.id
                WHERE _chj3.chat_id = c.id
                LIMIT 1
              )
            END as chat_name,
            (SELECT MAX(m.date) FROM message m
             JOIN chat_message_join cmj ON cmj.message_id = m.id
             WHERE cmj.chat_id = cm.chat_id) as latest_message_date
     FROM chat_metadata cm
     LEFT JOIN chat c ON c.id = cm.chat_id
     ORDER BY latest_message_date DESC NULLS LAST
     LIMIT $1`,
    [limit]
  );
  return result.rows;
}

async function executeTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'search_messages':
      return executeSearch(args);
    case 'get_context':
      return executeGetContext(args);
    case 'resolve_contact':
      return executeResolveContact(args);
    case 'get_chat_summaries':
      return executeGetChatSummaries(args);
    default:
      return { error: `Unknown tool: ${name}` };
  }
}

// --- Format results for the LLM ---

function formatSearchResultsForLLM(resultsWithContext: { result: SearchResult; context: ContextMessage[] }[]): string {
  if (resultsWithContext.length === 0) return 'No results found.';
  return resultsWithContext.map(({ result: r, context }, i) => {
    const sender = r.is_from_me ? 'Me' : (r.sender ?? 'Unknown');
    const date = r.date ? new Date(r.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'Unknown date';

    // Format context messages around the match
    const contextLines = context.map(m => {
      const ctxSender = m.is_from_me ? 'Me' : (m.sender ?? 'Unknown');
      const isMatch = m.id === r.id;
      const prefix = isMatch ? '>>>' : '   ';
      return `${prefix} MSG-${m.id} | ${ctxSender}: ${m.text ?? '[no text]'}`;
    }).join('\n');

    return `[${i + 1}] Match: MSG-${r.id} | ${sender} in "${r.chat_name ?? 'Unknown'}" (${date})\nConversation thread:\n${contextLines}`;
  }).join('\n\n---\n\n');
}

function formatContextForLLM(messages: ContextMessage[]): string {
  if (messages.length === 0) return 'No context messages found.';
  return messages.map(m => {
    const sender = m.is_from_me ? 'Me' : (m.sender ?? 'Unknown');
    const date = m.date ? new Date(m.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
    return `MSG-${m.id} | ${sender} (${date}): ${m.text ?? '[no text]'}`;
  }).join('\n');
}

// --- Agent response & progress types ---

export interface MessageLink {
  message_id: number;
  text: string;
  sender: string;
  date: string | null;
  chat_name: string | null;
}

export interface AgentProgressEvent {
  type: 'thinking' | 'tool_call' | 'tool_result' | 'done';
  description: string;      // Human-readable description
  tool?: string;
  result_summary?: string;
}

export interface AgentResponse {
  answer: string;
  message_links: MessageLink[];
  tool_calls_count: number;
  /** The date range of imported messages, so the UI can inform the user */
  data_range?: {
    earliest: string | null;
    latest: string | null;
    days_covered: number | null;
  };
}

export type ProgressCallback = (event: AgentProgressEvent) => void;

// --- Human-readable tool descriptions ---

function describeToolCall(name: string, args: Record<string, unknown>): string {
  switch (name) {
    case 'search_messages': {
      const parts: string[] = [];
      parts.push(`"${args.query}"`);
      if (args.with_contact) parts.push(`in conversations with ${args.with_contact}`);
      if (args.from_me) parts.push('sent by me');
      if (args.group_chat) parts.push(`in "${args.group_chat}"`);
      if (args.after || args.before) {
        const after = args.after ? String(args.after).split('T')[0] : '';
        const before = args.before ? String(args.before).split('T')[0] : '';
        if (after && before) parts.push(`between ${after} and ${before}`);
        else if (after) parts.push(`after ${after}`);
        else if (before) parts.push(`before ${before}`);
      }
      const mode = args.mode ? ` (${args.mode})` : '';
      return `Searching for ${parts.join(', ')}${mode}`;
    }
    case 'get_context':
      return `Reading conversation around message #${args.message_id}`;
    case 'resolve_contact':
      return `Looking up contact "${args.name}"`;
    case 'get_chat_summaries':
      return 'Fetching recent conversation summaries';
    default:
      return `Calling ${name}`;
  }
}

function describeToolResult(name: string, result: unknown): string {
  switch (name) {
    case 'search_messages': {
      const r = result as { results: SearchResult[]; total: number };
      if (r.total === 0) return 'No results found';
      return `Found ${r.total} message${r.total !== 1 ? 's' : ''}`;
    }
    case 'get_context': {
      const msgs = result as ContextMessage[];
      return `Got ${msgs.length} surrounding messages`;
    }
    case 'resolve_contact': {
      const contacts = result as { name: string; message_count: number }[];
      if (contacts.length === 0) return 'No matching contacts';
      return `Found: ${contacts.map(c => `${c.name} (${c.message_count} msgs)`).join(', ')}`;
    }
    case 'get_chat_summaries': {
      const rows = result as unknown[];
      return `Got ${rows.length} conversation summaries`;
    }
    default:
      return 'Done';
  }
}

// --- System prompt ---

async function getDataRange(): Promise<{ earliest: string | null; latest: string | null; totalMessages: number; daysCovered: number | null }> {
  const db = await getPglite();
  const earliest = await db.query('SELECT MIN(date) as earliest FROM message WHERE date IS NOT NULL');
  const latest = await db.query('SELECT MAX(date) as latest FROM message WHERE date IS NOT NULL');
  const count = await db.query('SELECT count(*) as cnt FROM message');
  const earliestDate = (earliest.rows[0] as any)?.earliest ?? null;
  const latestDate = (latest.rows[0] as any)?.latest ?? null;
  let daysCovered: number | null = null;
  if (earliestDate && latestDate) {
    daysCovered = Math.round((new Date(latestDate).getTime() - new Date(earliestDate).getTime()) / (1000 * 60 * 60 * 24));
  }
  return {
    earliest: earliestDate ? new Date(earliestDate).toISOString().split('T')[0] : null,
    latest: latestDate ? new Date(latestDate).toISOString().split('T')[0] : null,
    totalMessages: parseInt((count.rows[0] as any)?.cnt ?? '0', 10),
    daysCovered,
  };
}

function buildAgentSystemPrompt(dataRange: { earliest: string | null; daysCovered: number | null }): string {
  const now = new Date();
  const today = now.toISOString().split('T')[0];
  const dayOfWeek = now.toLocaleDateString('en-US', { weekday: 'long' });

  const rangeNote = dataRange.earliest && dataRange.daysCovered
    ? `\n\nIMPORTANT: You only have access to messages from the last ~${dataRange.daysCovered} days (since ${dataRange.earliest}). If your searches return no results, the answer may be in older messages outside this window.`
    : '';

  return `You are an intelligent assistant that helps users search and explore their iMessage history. Today is ${dayOfWeek}, ${today}.${rangeNote}

You have access to tools that let you search messages, look up contacts, get conversation context, and view chat summaries. Use these tools to thoroughly answer the user's question.

STRATEGY:
1. If the user mentions a person's name, ALWAYS call resolve_contact FIRST to find their exact name in the database. Names must match exactly for filters to work.
2. When searching for messages involving a person, use the "with_contact" parameter. It finds ALL messages in conversations with that person — both what they said and what you said to them.
3. Start with short, focused search queries (1-3 keywords). Long queries often return nothing.
4. If a search returns 0 results, try different keywords or "text" mode for exact matches.
5. Search results include a few surrounding messages for context. If you see something promising but the answer isn't visible yet, call get_context on that message ID with a larger "after" value (e.g. 15 or 20) to read further into the conversation.
6. Do NOT use the "after" or "before" date filters unless the user explicitly mentions a time range (e.g. "last week", "in January", "recently"). By default, search across all time.
7. If you can't find what the user is looking for after a few searches, let them know — the answer may be in older messages outside the imported window.

RESPONSE FORMAT:
- Give a clear, concise answer to the user's question
- Reference specific messages using [[MSG-ID]] notation (e.g. [[MSG-12345]]) — these will become clickable links
- Include relevant quotes from messages to support your answer

IMPORTANT:
- Always cite your sources with [[MSG-ID]] references
- Be specific about who said what and when
- If the answer spans multiple conversations, organize by conversation/person
- Don't make up information — only report what you actually find in the messages`;
}

// --- Anthropic agent loop ---

async function runAnthropicAgent(query: string, config: LLMConfig, onProgress?: ProgressCallback): Promise<AgentResponse> {
  const apiKey = config.anthropicApiKey;
  if (!apiKey) throw new Error('Anthropic API key is not configured');

  const client = new Anthropic({ apiKey });
  const model = config.model ?? 'claude-haiku-4-5-20251001';

  const dataRange = await getDataRange();

  // Convert tools to Anthropic format
  const anthropicTools: Anthropic.Messages.Tool[] = TOOLS.map(t => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters as Anthropic.Messages.Tool.InputSchema,
  }));

  const messages: Anthropic.Messages.MessageParam[] = [
    { role: 'user', content: query },
  ];

  const collectedLinks: MessageLink[] = [];
  let toolCallsCount = 0;

  const MAX_ITERATIONS = 10;

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    console.log(`[agent] Iteration ${i + 1}, sending ${messages.length} messages to ${model}`);
    onProgress?.({ type: 'thinking', description: i === 0 ? `Searching ${dataRange.daysCovered ? `~${dataRange.daysCovered} days` : ''} of messages...` : 'Analyzing results...' });

    const response = await client.messages.create({
      model,
      max_tokens: 4096,
      system: buildAgentSystemPrompt(dataRange),
      tools: anthropicTools,
      messages,
    });

    // Check if model wants to use tools
    const toolUseBlocks = response.content.filter(
      (block): block is Anthropic.Messages.ToolUseBlock => block.type === 'tool_use'
    );

    if (toolUseBlocks.length === 0 || response.stop_reason === 'end_turn') {
      // Model is done — extract final text
      const textBlocks = response.content.filter(
        (block): block is Anthropic.Messages.TextBlock => block.type === 'text'
      );
      const answer = textBlocks.map(b => b.text).join('\n');

      // Extract MSG-IDs from the answer to build links
      const msgIdRegex = /\[\[MSG-(\d+)\]\]/g;
      const seenIds = new Set<number>();
      let match;
      while ((match = msgIdRegex.exec(answer)) !== null) {
        const msgId = parseInt(match[1], 10);
        if (!seenIds.has(msgId)) {
          seenIds.add(msgId);
          // Find this message in our collected links or fetch it
          const existing = collectedLinks.find(l => l.message_id === msgId);
          if (!existing) {
            // Fetch from DB
            const db = await getPglite();
            const result = await db.query(
              `SELECT m.id, m.text, m.is_from_me, m.date,
                      COALESCE(h.display_name, h.identifier) as sender,
                      COALESCE(c.display_name, COALESCE(h2.display_name, h2.identifier)) as chat_name
               FROM message m
               LEFT JOIN handle h ON m.handle_id = h.id
               LEFT JOIN chat_message_join cmj ON cmj.message_id = m.id
               LEFT JOIN chat c ON c.id = cmj.chat_id
               LEFT JOIN chat_handle_join chj ON chj.chat_id = c.id
               LEFT JOIN handle h2 ON chj.handle_id = h2.id
               WHERE m.id = $1
               LIMIT 1`,
              [msgId]
            );
            if (result.rows.length > 0) {
              const row = result.rows[0] as any;
              collectedLinks.push({
                message_id: msgId,
                text: row.text ?? '',
                sender: row.is_from_me ? 'Me' : (row.sender ?? 'Unknown'),
                date: row.date ? new Date(row.date).toISOString() : null,
                chat_name: row.chat_name,
              });
            }
          }
        }
      }

      return { answer, message_links: collectedLinks, tool_calls_count: toolCallsCount, data_range: { earliest: dataRange.earliest, latest: dataRange.latest, days_covered: dataRange.daysCovered } };
    }

    // Execute tool calls
    messages.push({ role: 'assistant', content: response.content });

    const toolResults: Anthropic.Messages.ToolResultBlockParam[] = [];
    for (const toolUse of toolUseBlocks) {
      toolCallsCount++;
      const toolArgs = toolUse.input as Record<string, unknown>;
      const humanDesc = describeToolCall(toolUse.name, toolArgs);
      console.log(`[agent] Tool call #${toolCallsCount}: ${toolUse.name}(${JSON.stringify(toolArgs)})`);
      onProgress?.({ type: 'tool_call', description: humanDesc, tool: toolUse.name });

      try {
        const result = await executeTool(toolUse.name, toolArgs);
        const resultSummary = describeToolResult(toolUse.name, result);
        onProgress?.({ type: 'tool_result', description: resultSummary, tool: toolUse.name, result_summary: resultSummary });

        // Format results nicely for the LLM
        let formattedResult: string;
        if (toolUse.name === 'search_messages') {
          const searchResult = result as { results: SearchResult[]; resultsWithContext: { result: SearchResult; context: ContextMessage[] }[]; total: number };
          formattedResult = `Found ${searchResult.total} results:\n\n${formatSearchResultsForLLM(searchResult.resultsWithContext)}`;

          // Collect message links from search results
          for (const r of searchResult.results) {
            if (!collectedLinks.find(l => l.message_id === r.id)) {
              collectedLinks.push({
                message_id: r.id,
                text: r.text,
                sender: r.is_from_me ? 'Me' : (r.sender ?? 'Unknown'),
                date: r.date ? new Date(r.date).toISOString() : null,
                chat_name: r.chat_name,
              });
            }
          }
        } else if (toolUse.name === 'get_context') {
          const contextMessages = result as ContextMessage[];
          formattedResult = formatContextForLLM(contextMessages);

          for (const m of contextMessages) {
            if (!collectedLinks.find(l => l.message_id === m.id)) {
              collectedLinks.push({
                message_id: m.id,
                text: m.text ?? '',
                sender: m.is_from_me ? 'Me' : (m.sender ?? 'Unknown'),
                date: m.date ? new Date(m.date).toISOString() : null,
                chat_name: null,
              });
            }
          }
        } else {
          formattedResult = JSON.stringify(result, null, 2);
        }

        console.log(`[agent] Tool result for ${toolUse.name}: ${formattedResult.slice(0, 200)}${formattedResult.length > 200 ? '...' : ''}`);
        toolResults.push({ type: 'tool_result', tool_use_id: toolUse.id, content: formattedResult });
      } catch (err) {
        const errorMsg = `Error: ${(err as Error).message}`;
        console.log(`[agent] Tool error for ${toolUse.name}: ${errorMsg}`);
        toolResults.push({ type: 'tool_result', tool_use_id: toolUse.id, content: errorMsg, is_error: true });
      }
    }

    messages.push({ role: 'user', content: toolResults });
  }

  return { answer: 'Agent reached maximum iterations without producing a final answer.', message_links: collectedLinks, tool_calls_count: toolCallsCount, data_range: { earliest: dataRange.earliest, latest: dataRange.latest, days_covered: dataRange.daysCovered } };
}

// --- OpenAI agent loop ---

async function runOpenAIAgent(query: string, config: LLMConfig, onProgress?: ProgressCallback): Promise<AgentResponse> {
  const apiKey = config.openaiApiKey;
  if (!apiKey) throw new Error('OpenAI API key is not configured');

  const client = new OpenAI({ apiKey });
  const model = config.model ?? 'gpt-4o-mini';

  const dataRange = await getDataRange();

  const openaiTools: OpenAI.ChatCompletionTool[] = TOOLS.map(t => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));

  const messages: OpenAI.ChatCompletionMessageParam[] = [
    { role: 'system', content: buildAgentSystemPrompt(dataRange) },
    { role: 'user', content: query },
  ];

  const collectedLinks: MessageLink[] = [];
  let toolCallsCount = 0;

  const MAX_ITERATIONS = 10;

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    console.log(`[agent] Iteration ${i + 1}, sending ${messages.length} messages to ${model}`);
    onProgress?.({ type: 'thinking', description: i === 0 ? `Searching ${dataRange.daysCovered ? `~${dataRange.daysCovered} days` : ''} of messages...` : 'Analyzing results...' });

    const response = await client.chat.completions.create({
      model,
      max_tokens: 4096,
      tools: openaiTools,
      messages,
    });

    const choice = response.choices[0];
    if (!choice) break;

    const toolCalls = choice.message.tool_calls;

    if (!toolCalls || toolCalls.length === 0 || choice.finish_reason === 'stop') {
      const answer = choice.message.content ?? '';

      // Extract MSG-IDs
      const msgIdRegex = /\[\[MSG-(\d+)\]\]/g;
      const seenIds = new Set<number>();
      let match;
      while ((match = msgIdRegex.exec(answer)) !== null) {
        const msgId = parseInt(match[1], 10);
        if (!seenIds.has(msgId)) {
          seenIds.add(msgId);
          const existing = collectedLinks.find(l => l.message_id === msgId);
          if (!existing) {
            const db = await getPglite();
            const result = await db.query(
              `SELECT m.id, m.text, m.is_from_me, m.date,
                      COALESCE(h.display_name, h.identifier) as sender,
                      COALESCE(c.display_name, COALESCE(h2.display_name, h2.identifier)) as chat_name
               FROM message m
               LEFT JOIN handle h ON m.handle_id = h.id
               LEFT JOIN chat_message_join cmj ON cmj.message_id = m.id
               LEFT JOIN chat c ON c.id = cmj.chat_id
               LEFT JOIN chat_handle_join chj ON chj.chat_id = c.id
               LEFT JOIN handle h2 ON chj.handle_id = h2.id
               WHERE m.id = $1
               LIMIT 1`,
              [msgId]
            );
            if (result.rows.length > 0) {
              const row = result.rows[0] as any;
              collectedLinks.push({
                message_id: msgId,
                text: row.text ?? '',
                sender: row.is_from_me ? 'Me' : (row.sender ?? 'Unknown'),
                date: row.date ? new Date(row.date).toISOString() : null,
                chat_name: row.chat_name,
              });
            }
          }
        }
      }

      return { answer, message_links: collectedLinks, tool_calls_count: toolCallsCount, data_range: { earliest: dataRange.earliest, latest: dataRange.latest, days_covered: dataRange.daysCovered } };
    }

    // Execute tool calls
    messages.push(choice.message);

    for (const toolCall of toolCalls) {
      if (toolCall.type !== 'function') continue;
      const fn = toolCall.function;
      toolCallsCount++;
      const toolArgs = JSON.parse(fn.arguments) as Record<string, unknown>;
      const humanDesc = describeToolCall(fn.name, toolArgs);
      console.log(`[agent] Tool call #${toolCallsCount}: ${fn.name}(${JSON.stringify(toolArgs)})`);
      onProgress?.({ type: 'tool_call', description: humanDesc, tool: fn.name });

      try {
        const result = await executeTool(fn.name, toolArgs);
        const resultSummary = describeToolResult(fn.name, result);
        onProgress?.({ type: 'tool_result', description: resultSummary, tool: fn.name, result_summary: resultSummary });

        let formattedResult: string;
        if (fn.name === 'search_messages') {
          const searchResult = result as { results: SearchResult[]; resultsWithContext: { result: SearchResult; context: ContextMessage[] }[]; total: number };
          formattedResult = `Found ${searchResult.total} results:\n\n${formatSearchResultsForLLM(searchResult.resultsWithContext)}`;

          for (const r of searchResult.results) {
            if (!collectedLinks.find(l => l.message_id === r.id)) {
              collectedLinks.push({
                message_id: r.id,
                text: r.text,
                sender: r.is_from_me ? 'Me' : (r.sender ?? 'Unknown'),
                date: r.date ? new Date(r.date).toISOString() : null,
                chat_name: r.chat_name,
              });
            }
          }
        } else if (fn.name === 'get_context') {
          const contextMessages = result as ContextMessage[];
          formattedResult = formatContextForLLM(contextMessages);

          for (const m of contextMessages) {
            if (!collectedLinks.find(l => l.message_id === m.id)) {
              collectedLinks.push({
                message_id: m.id,
                text: m.text ?? '',
                sender: m.is_from_me ? 'Me' : (m.sender ?? 'Unknown'),
                date: m.date ? new Date(m.date).toISOString() : null,
                chat_name: null,
              });
            }
          }
        } else {
          formattedResult = JSON.stringify(result, null, 2);
        }

        console.log(`[agent] Tool result for ${fn.name}: ${formattedResult.slice(0, 200)}${formattedResult.length > 200 ? '...' : ''}`);
        messages.push({ role: 'tool', tool_call_id: toolCall.id, content: formattedResult });
      } catch (err) {
        const errorMsg = `Error: ${(err as Error).message}`;
        console.log(`[agent] Tool error for ${fn.name}: ${errorMsg}`);
        messages.push({ role: 'tool', tool_call_id: toolCall.id, content: errorMsg });
      }
    }
  }

  return { answer: 'Agent reached maximum iterations without producing a final answer.', message_links: collectedLinks, tool_calls_count: toolCallsCount, data_range: { earliest: dataRange.earliest, latest: dataRange.latest, days_covered: dataRange.daysCovered } };
}

// --- Main entry point ---

export async function runAgent(query: string, config: LLMConfig, onProgress?: ProgressCallback): Promise<AgentResponse> {
  const provider = getModelProvider(config.model ?? 'claude-haiku-4-5-20251001');
  console.log(`[agent] Starting agent for query: "${query}" (provider: ${provider}, model: ${config.model})`);

  if (provider === 'openai') {
    return runOpenAIAgent(query, config, onProgress);
  } else {
    return runAnthropicAgent(query, config, onProgress);
  }
}
