#!/usr/bin/env node

/**
 * MCP (Model Context Protocol) server for iMessage search.
 * Exposes tools that let Claude Code search messages, ask questions,
 * get context, view actions/events, and search contacts.
 *
 * Proxies to the local HTTP API at localhost:11488.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const API_BASE = 'http://localhost:11488';

async function apiGet(path: string, params: Record<string, string> = {}): Promise<any> {
  const url = new URL(path, API_BASE);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== '') url.searchParams.set(k, v);
  }
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`API error ${res.status}: ${await res.text()}`);
  return res.json();
}

async function apiPost(path: string, body?: any, params: Record<string, string> = {}): Promise<any> {
  const url = new URL(path, API_BASE);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== '') url.searchParams.set(k, v);
  }
  const res = await fetch(url.toString(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`API error ${res.status}: ${await res.text()}`);
  return res.json();
}

/**
 * Call the agent endpoint, which streams NDJSON.
 * Collect progress events and return the final result.
 */
async function callAgent(query: string): Promise<{ answer: string; message_links: any[]; tool_calls_count: number }> {
  const url = new URL('/api/agent', API_BASE);
  const res = await fetch(url.toString(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  if (!res.ok) throw new Error(`Agent API error ${res.status}: ${await res.text()}`);

  const text = await res.text();
  const lines = text.trim().split('\n');

  for (const line of lines) {
    const event = JSON.parse(line);
    if (event.stream === 'error') throw new Error(event.message);
    if (event.stream === 'result') return event;
  }

  throw new Error('Agent returned no result');
}

const server = new McpServer({
  name: 'imessage-agent',
  version: '1.0.0',
});

// --- Tool: ask_agent ---
server.tool(
  'ask_agent',
  `Ask a natural language question about the user's iMessage history. An AI agent will search messages, resolve contacts, and synthesize an answer. Use this for open-ended questions like "what did Sarah say about the trip?" or "when is the dinner with Mike?". Returns a text answer with links to specific messages.`,
  {
    query: z.string().describe('Natural language question about messages'),
  },
  async ({ query }) => {
    const result = await callAgent(query);
    let text = result.answer;
    if (result.message_links.length > 0) {
      text += '\n\nReferenced messages:\n' + result.message_links.map(
        (l: any) => `- [Message ${l.message_id}] ${l.sender ?? 'Me'}: "${l.text?.slice(0, 100)}..." (${l.date})`
      ).join('\n');
    }
    return { content: [{ type: 'text', text }] };
  }
);

// --- Tool: search_messages ---
server.tool(
  'search_messages',
  `Search iMessage history with structured filters. Use this when you need precise control over the search (specific sender, date range, text keywords). Supports text, semantic, and hybrid search modes.`,
  {
    query: z.string().describe('Search query text'),
    mode: z.enum(['text', 'semantic', 'hybrid']).default('hybrid').describe('Search mode: text (keyword match), semantic (meaning-based), or hybrid (both)'),
    from: z.string().optional().describe('Filter by sender name or identifier'),
    after: z.string().optional().describe('Messages after this date (YYYY-MM-DD)'),
    before: z.string().optional().describe('Messages before this date (YYYY-MM-DD)'),
    from_me: z.boolean().optional().describe('Only messages sent by the user'),
    to_me: z.boolean().optional().describe('Only messages received by the user'),
    group_chat: z.string().optional().describe('Filter by group chat name'),
    limit: z.number().default(20).describe('Max results to return'),
  },
  async ({ query, mode, from, after, before, from_me, to_me, group_chat, limit }) => {
    const params: Record<string, string> = {
      q: query,
      mode,
      limit: String(limit),
    };
    if (from) params.from = from;
    if (after) params.after = after;
    if (before) params.before = before;
    if (from_me) params.fromMe = 'true';
    if (to_me) params.toMe = 'true';
    if (group_chat) params.groupChatName = group_chat;

    const data = await apiGet('/api/search', params);
    if (data.results.length === 0) {
      return { content: [{ type: 'text', text: 'No messages found.' }] };
    }

    const lines = data.results.map((r: any) =>
      `[Message ${r.id}] ${r.date} | ${r.is_from_me ? 'Me' : r.sender} | ${r.text}`
    );
    return {
      content: [{ type: 'text', text: `Found ${data.count} message(s):\n\n${lines.join('\n')}` }],
    };
  }
);

// --- Tool: get_message_context ---
server.tool(
  'get_message_context',
  `Get messages surrounding a specific message ID. Use this to see the full conversation context around a search result or referenced message.`,
  {
    message_id: z.number().describe('The message ID to get context for'),
    before: z.number().default(5).describe('Number of messages before'),
    after: z.number().default(5).describe('Number of messages after'),
  },
  async ({ message_id, before, after }) => {
    const data = await apiGet('/api/context', {
      messageId: String(message_id),
      before: String(before),
      after: String(after),
    });

    if (data.messages.length === 0) {
      return { content: [{ type: 'text', text: 'Message not found.' }] };
    }

    const lines = data.messages.map((m: any) =>
      `[${m.date}] ${m.is_from_me ? 'Me' : m.sender}: ${m.text}`
    );
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  }
);

// --- Tool: get_actions ---
server.tool(
  'get_actions',
  `Get the user's pending tasks and upcoming events extracted from iMessage conversations. Tasks are grouped into three buckets: "To Do" (actionable now), "Upcoming" (future-dated, not yet actionable), and "Waiting" (ball in someone else's court). Events are upcoming plans (dinners, trips, birthdays, etc.).`,
  {
    include_completed: z.boolean().default(false).describe('Include completed/removed items'),
  },
  async ({ include_completed }) => {
    const data = await apiGet('/api/actions', {
      completed: include_completed ? 'true' : 'false',
    });

    const parts: string[] = [];

    if (data.key_events.length > 0) {
      parts.push('## Upcoming Events\n' + data.key_events.map((e: any) =>
        `- ${e.title}${e.date ? ` (${e.date})` : ''}${e.location ? ` at ${e.location}` : ''} — from chat with ${e.chat_name}`
      ).join('\n'));
    }

    const todoTasks = data.tasks.filter((t: any) => t.bucket === 'todo');
    const upcomingTasks = data.tasks.filter((t: any) => t.bucket === 'upcoming');
    const waitingTasks = data.tasks.filter((t: any) => t.bucket === 'waiting');

    if (todoTasks.length > 0) {
      parts.push('## To Do\n' + todoTasks.map((t: any) =>
        `- [${t.priority}] ${t.title}${t.date ? ` (due ${t.date})` : ''} — from chat with ${t.chat_name}${t.completed ? ' ✓' : ''}`
      ).join('\n'));
    }

    if (upcomingTasks.length > 0) {
      parts.push('## Upcoming\n' + upcomingTasks.map((t: any) =>
        `- [${t.priority}] ${t.title}${t.date ? ` (${t.date})` : ''} — from chat with ${t.chat_name}`
      ).join('\n'));
    }

    if (waitingTasks.length > 0) {
      parts.push('## Waiting\n' + waitingTasks.map((t: any) =>
        `- ${t.title}${t.date ? ` (${t.date})` : ''} — from chat with ${t.chat_name}`
      ).join('\n'));
    }

    if (parts.length === 0) {
      return { content: [{ type: 'text', text: 'No pending actions or events.' }] };
    }

    return { content: [{ type: 'text', text: parts.join('\n\n') }] };
  }
);

// --- Tool: search_contacts ---
server.tool(
  'search_contacts',
  `Search for contacts in the user's iMessage history. Returns matching names and identifiers. Use this to find the right person before searching messages.`,
  {
    query: z.string().describe('Contact name or phone/email to search for'),
    limit: z.number().default(5).describe('Max results'),
  },
  async ({ query, limit }) => {
    const data = await apiGet('/api/contacts/search', {
      q: query,
      limit: String(limit),
    });

    if (data.matches.length === 0) {
      return { content: [{ type: 'text', text: 'No matching contacts found.' }] };
    }

    const lines = data.matches.map((m: any) =>
      `- ${m.displayName ?? m.identifier} (${m.identifier}, ${m.messageCount} messages)`
    );
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  }
);

// --- Start server ---
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('MCP server error:', err);
  process.exit(1);
});
