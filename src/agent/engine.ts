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
    description: `Search through iMessage history. Returns matching messages with sender, date, chat name, and message ID.

IMPORTANT TIPS:
- Start with a simple query without filters to see if results exist, then narrow down.
- The "with_contact" filter searches ALL messages in conversations with that person (both sent and received). This is the best way to find messages involving a specific person.
- The "from" filter only matches messages sent BY that specific person (not messages you sent to them). Prefer "with_contact" unless you specifically need only messages they sent.
- If a search returns 0 results, try: (1) broader/different keywords, (2) "text" mode for exact words or "semantic" mode for meaning, (3) removing filters and searching more broadly.
- Use resolve_contact first if you're unsure of the exact contact name.`,
    parameters: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'The search query — topic keywords to search for. Keep it short and focused (1-3 words work best).' },
        mode: { type: 'string', enum: ['text', 'semantic', 'hybrid'], description: 'Search mode. "text" for exact keyword matching, "semantic" for meaning-based search, "hybrid" for best of both. Default: hybrid. Try "text" if hybrid returns nothing.' },
        with_contact: { type: 'string', description: 'Filter to messages in conversations WITH this person (both sent and received). This is the recommended way to filter by person.' },
        from: { type: 'string', description: 'Filter to messages sent BY this specific person only. Use "with_contact" instead unless you only want messages they sent.' },
        after: { type: 'string', description: 'ISO date string — only messages after this date' },
        before: { type: 'string', description: 'ISO date string — only messages before this date' },
        from_me: { type: 'boolean', description: 'If true, only show messages I sent' },
        group_chat: { type: 'string', description: 'Filter to a specific group chat by name' },
        limit: { type: 'number', description: 'Max results to return (default 10, max 30)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_context',
    description: 'Get surrounding messages for a specific message ID. Use this to see what was said before and after a particular message to understand the full conversation context. Always use this when you find a relevant message — the surrounding context often contains the actual answer.',
    parameters: {
      type: 'object' as const,
      properties: {
        message_id: { type: 'number', description: 'The message ID to get context for' },
        before: { type: 'number', description: 'Number of messages before (default 5)' },
        after: { type: 'number', description: 'Number of messages after (default 10)' },
      },
      required: ['message_id'],
    },
  },
  {
    name: 'resolve_contact',
    description: 'Look up a contact by name to find their exact name as stored in the database and their message count. ALWAYS call this first before using "with_contact" or "from" filters in search_messages — the name must match exactly what\'s in the database.',
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

async function executeSearch(args: Record<string, unknown>): Promise<{ results: SearchResult[]; total: number }> {
  const query = args.query as string;
  const mode = (args.mode as string) || 'hybrid';
  const limit = Math.min((args.limit as number) || 10, 30);

  const options: SearchOptions = {
    mode: mode as SearchOptions['mode'],
    limit,
    offset: 0,
    context: 0,
  };

  // with_contact: filter to conversations WITH this person (recommended)
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

  // from: filter to messages sent BY this person only
  if (args.from) {
    const fromName = args.from as string;
    const matches = await searchContacts(fromName, 5);
    console.log(`[agent] resolve from "${fromName}": ${matches.length} matches → ${matches.map(m => `${m.displayName ?? m.identifier} (score: ${m.score}, handle: ${m.handleId})`).join(', ')}`);
    if (matches.length > 0) {
      options.handleIds = matches.map(m => m.handleId);
    } else {
      options.from = fromName;
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

  console.log(`[agent] search returned ${results.length} results`);
  return { results, total: results.length };
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

function formatSearchResultsForLLM(results: SearchResult[]): string {
  if (results.length === 0) return 'No results found.';
  return results.map((r, i) => {
    const sender = r.is_from_me ? 'Me' : (r.sender ?? 'Unknown');
    const date = r.date ? new Date(r.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'Unknown date';
    return `[${i + 1}] MSG-${r.id} | ${sender} in "${r.chat_name ?? 'Unknown'}" (${date}):\n  "${r.text}"`;
  }).join('\n\n');
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
}

export type ProgressCallback = (event: AgentProgressEvent) => void;

// --- Human-readable tool descriptions ---

function describeToolCall(name: string, args: Record<string, unknown>): string {
  switch (name) {
    case 'search_messages': {
      const parts: string[] = [];
      parts.push(`"${args.query}"`);
      if (args.with_contact) parts.push(`in conversations with ${args.with_contact}`);
      if (args.from) parts.push(`from ${args.from}`);
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

function buildAgentSystemPrompt(): string {
  const now = new Date();
  const today = now.toISOString().split('T')[0];
  const dayOfWeek = now.toLocaleDateString('en-US', { weekday: 'long' });

  return `You are an intelligent assistant that helps users search and explore their iMessage history. Today is ${dayOfWeek}, ${today}.

You have access to tools that let you search messages, look up contacts, get conversation context, and view chat summaries. Use these tools to thoroughly answer the user's question.

STRATEGY:
1. If the user mentions a person's name, ALWAYS call resolve_contact FIRST to find their exact name in the database. Names must match exactly for filters to work.
2. When searching for messages involving a person, use the "with_contact" parameter (NOT "from"). "with_contact" finds all messages in conversations with that person. "from" only finds messages they sent, missing messages you sent to them.
3. Start with short, focused search queries (1-3 keywords). Long queries often return nothing.
4. If a search returns 0 results, try: different keywords, "text" mode for exact matches, or remove filters and search more broadly.
5. Use get_context to read the full conversation around interesting messages — the surrounding messages often contain the real answer.
6. You can make multiple searches with different queries to be thorough.

RESPONSE FORMAT:
- Give a clear, concise answer to the user's question
- Reference specific messages using [[MSG-ID]] notation (e.g. [[MSG-12345]]) — these will become clickable links
- Include relevant quotes from messages to support your answer
- If you can't find what the user is looking for, say so and suggest what they might try differently

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
    onProgress?.({ type: 'thinking', description: i === 0 ? 'Thinking...' : 'Analyzing results...' });

    const response = await client.messages.create({
      model,
      max_tokens: 4096,
      system: buildAgentSystemPrompt(),
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

      return { answer, message_links: collectedLinks, tool_calls_count: toolCallsCount };
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
          const searchResult = result as { results: SearchResult[]; total: number };
          formattedResult = `Found ${searchResult.total} results:\n\n${formatSearchResultsForLLM(searchResult.results)}`;

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

  return { answer: 'Agent reached maximum iterations without producing a final answer.', message_links: collectedLinks, tool_calls_count: toolCallsCount };
}

// --- OpenAI agent loop ---

async function runOpenAIAgent(query: string, config: LLMConfig, onProgress?: ProgressCallback): Promise<AgentResponse> {
  const apiKey = config.openaiApiKey;
  if (!apiKey) throw new Error('OpenAI API key is not configured');

  const client = new OpenAI({ apiKey });
  const model = config.model ?? 'gpt-4o-mini';

  const openaiTools: OpenAI.ChatCompletionTool[] = TOOLS.map(t => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));

  const messages: OpenAI.ChatCompletionMessageParam[] = [
    { role: 'system', content: buildAgentSystemPrompt() },
    { role: 'user', content: query },
  ];

  const collectedLinks: MessageLink[] = [];
  let toolCallsCount = 0;
  const MAX_ITERATIONS = 10;

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    console.log(`[agent] Iteration ${i + 1}, sending ${messages.length} messages to ${model}`);
    onProgress?.({ type: 'thinking', description: i === 0 ? 'Thinking...' : 'Analyzing results...' });

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

      return { answer, message_links: collectedLinks, tool_calls_count: toolCallsCount };
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
          const searchResult = result as { results: SearchResult[]; total: number };
          formattedResult = `Found ${searchResult.total} results:\n\n${formatSearchResultsForLLM(searchResult.results)}`;

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

  return { answer: 'Agent reached maximum iterations without producing a final answer.', message_links: collectedLinks, tool_calls_count: toolCallsCount };
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
