import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';

export interface ParsedQuery {
  query: string;
  from?: string;
  groupChatName?: string;
  after?: string;
  before?: string;
  fromMe?: boolean;
  toMe?: boolean;
  mode?: 'text' | 'semantic' | 'hybrid';
}

export interface LLMConfig {
  model: string;
  actionsModel?: string;
  anthropicApiKey?: string;
  openaiApiKey?: string;
}

export interface ModelOption {
  id: string;
  name: string;
  provider: 'anthropic' | 'openai';
}

export const AVAILABLE_MODELS: ModelOption[] = [
  { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5', provider: 'anthropic' },
  { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', provider: 'anthropic' },
  { id: 'gpt-4.1-nano', name: 'GPT-4.1 Nano', provider: 'openai' },
  { id: 'gpt-4.1-mini', name: 'GPT-4.1 Mini', provider: 'openai' },
  { id: 'gpt-4o-mini', name: 'GPT-4o Mini', provider: 'openai' },
  { id: 'gpt-4o', name: 'GPT-4o', provider: 'openai' },
];

let anthropicClient: Anthropic | null = null;
let anthropicClientKey: string | undefined = undefined;
let openaiClient: OpenAI | null = null;
let openaiClientKey: string | undefined = undefined;

// Tracks the last API key authentication error detected during LLM calls
let lastApiKeyError: { provider: string; message: string; timestamp: string } | null = null;

export function getApiKeyError() { return lastApiKeyError; }
export function clearApiKeyError() { lastApiKeyError = null; }

function isAuthError(err: unknown): boolean {
  if (err && typeof err === 'object') {
    const status = (err as any).status ?? (err as any).statusCode;
    if (status === 401 || status === 403) return true;
    const msg = (err as any).message ?? '';
    if (typeof msg === 'string' && (msg.includes('authentication') || msg.includes('invalid.*api.*key') || msg.includes('Incorrect API key'))) return true;
  }
  return false;
}

function getAnthropicClient(apiKey?: string): Anthropic {
  const key = apiKey || undefined;
  if (!key) {
    throw new Error('Anthropic API key is not configured. Add one in Settings.');
  }
  if (!anthropicClient || key !== anthropicClientKey) {
    anthropicClientKey = key;
    anthropicClient = new Anthropic({ apiKey: key, timeout: 60_000 });
  }
  return anthropicClient;
}

function getOpenAIClient(apiKey?: string): OpenAI {
  const key = apiKey || undefined;
  if (!key) {
    throw new Error('OpenAI API key is not configured. Add one in Settings.');
  }
  if (!openaiClient || key !== openaiClientKey) {
    openaiClientKey = key;
    openaiClient = new OpenAI({ apiKey: key, timeout: 60_000 });
  }
  return openaiClient;
}

function buildSystemPrompt(): string {
  const now = new Date();
  const today = now.toISOString().split('T')[0];
  const dayOfWeek = now.toLocaleDateString('en-US', { weekday: 'long' });

  return `You are a query parser for an iMessage search engine. Today is ${dayOfWeek}, ${today}.

Given a natural language query about searching text messages, extract structured search parameters as JSON.

CRITICAL RULES:
- "query" = ONLY the topic/content keywords. Strip out sender names, dates, and filler words like "texts", "messages", "from", "about".
- "from" = person's name ONLY if "from <name>" or "by <name>" appears. "from margaret" → from: "margaret". Do NOT set fromMe.
- "groupChatName" = group chat name ONLY if the user explicitly says "in the <name> chat" or "in the <name> group". NEVER put search keywords in "groupChatName". NEVER set "groupChatName" unless the word "chat", "group", or "conversation" appears in the input.
- "after"/"before" = ONLY if the user mentions a specific time (yesterday, last week, last month, a date). Do NOT add dates if no time is mentioned.
- "fromMe" = true ONLY if the user says "I sent", "my messages", "messages I wrote", etc.
- "toMe" = true ONLY if the user says "sent to me", "I received", etc.
- "mode" = search mode. Only set if the user explicitly requests a mode. Options: "text", "semantic", "hybrid".
- OMIT any field that is not explicitly mentioned. When in doubt, leave it out.

Date conversions (only when explicitly mentioned):
- "yesterday" → after: day before ${today}, before: day before ${today}
- "last week" / "past week" / "this week" → after: 7 days before ${today}, before: ${today}
- "last month" / "past month" → after: first day of previous month, before: last day of previous month
- "past few days" / "past couple days" → after: 3-4 days before ${today}, before: ${today}
- "recently" / "lately" → after: 14 days before ${today}, before: ${today}
- "this morning" → after: ${today}

Examples:
- "texts from margaret about school buses" → {"query": "school buses", "from": "margaret"}
- "what did sarah say about the party" → {"query": "party", "from": "sarah"}
- "messages about dinner last week" → {"query": "dinner", "after": "<7 days ago>", "before": "${today}"}
- "texts from the past week about pizza" → {"query": "pizza", "after": "<7 days ago>", "before": "${today}"}
- "find pizza" → {"query": "pizza"}
- "texts I sent to mike about football" → {"query": "football", "fromMe": true}
- "messages about hiking in colorado" → {"query": "hiking in colorado"} (NOT groupChatName: "colorado")
- "in the family chat about vacation" → {"query": "vacation", "groupChatName": "family"}

Respond with ONLY valid JSON. No markdown, no explanation.`;
}

export function getModelProvider(modelId: string): 'anthropic' | 'openai' {
  const model = AVAILABLE_MODELS.find((m) => m.id === modelId);
  return model?.provider ?? (modelId.startsWith('gpt') ? 'openai' : 'anthropic');
}

async function callAnthropic(input: string, model: string, apiKey?: string): Promise<string> {
  const client = getAnthropicClient(apiKey);
  const response = await client.messages.create({
    model,
    max_tokens: 256,
    system: buildSystemPrompt(),
    messages: [{ role: 'user', content: input }],
  });
  return response.content[0].type === 'text' ? response.content[0].text : '';
}

async function callOpenAI(input: string, model: string, apiKey?: string): Promise<string> {
  const client = getOpenAIClient(apiKey);
  const response = await client.chat.completions.create({
    model,
    max_tokens: 256,
    messages: [
      { role: 'system', content: buildSystemPrompt() },
      { role: 'user', content: input },
    ],
  });
  return response.choices[0]?.message?.content ?? '';
}

/**
 * Call the appropriate LLM provider based on model selection.
 * Shared by query parsing, metadata, and action extraction.
 */
const MAX_RETRIES = 5;
const INITIAL_BACKOFF_MS = 1000;

async function callLLMOnce(
  config: LLMConfig,
  system: string,
  userMessage: string,
  maxTokens: number,
  model: string
): Promise<string> {
  const provider = getModelProvider(model);

  try {
    if (provider === 'openai') {
      const hasKey = !!config.openaiApiKey;
      console.log(`[llm] Calling ${model} (provider: openai, key present: ${hasKey})`);
      const client = getOpenAIClient(config.openaiApiKey);
      const response = await client.chat.completions.create({
        model,
        max_tokens: maxTokens,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: userMessage },
        ],
      });
      return response.choices[0]?.message?.content ?? '';
    } else {
      const hasKey = !!config.anthropicApiKey;
      console.log(`[llm] Calling ${model} (provider: anthropic, key present: ${hasKey})`);
      const client = getAnthropicClient(config.anthropicApiKey);
      const response = await client.messages.create({
        model,
        max_tokens: maxTokens,
        system,
        messages: [{ role: 'user', content: userMessage }],
      });
      return response.content[0].type === 'text' ? response.content[0].text : '';
    }
  } catch (err) {
    if (isAuthError(err)) {
      const msg = (err as any).message ?? 'Invalid API key';
      lastApiKeyError = { provider, message: msg, timestamp: new Date().toISOString() };
      console.error(`[llm] API key error for ${provider}: ${msg}`);
    }
    throw err;
  }
}

/**
 * Validate an API key by making a minimal test call.
 * Returns null on success, or an error message string on failure.
 */
export async function validateApiKey(provider: 'anthropic' | 'openai', apiKey: string): Promise<string | null> {
  // Strip non-ASCII characters (smart quotes, ellipses, etc.) that can sneak in from rich-text paste
  const cleanKey = apiKey.replace(/[^\x20-\x7E]/g, '').trim();
  if (cleanKey !== apiKey.trim()) {
    return 'API key contains invalid characters — try pasting it from a plain text source.';
  }
  try {
    if (provider === 'anthropic') {
      const client = new Anthropic({ apiKey });
      await client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'hi' }],
      });
    } else {
      const client = new OpenAI({ apiKey });
      await client.chat.completions.create({
        model: 'gpt-4o-mini',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'hi' }],
      });
    }
    // If we get here, the key works — clear any stored error for this provider
    if (lastApiKeyError?.provider === provider) {
      lastApiKeyError = null;
    }
    return null;
  } catch (err) {
    const status = (err as any).status ?? (err as any).statusCode;
    const msg = (err as any).message ?? 'Unknown error';
    if (status === 401 || status === 403 || isAuthError(err)) {
      return 'Invalid API key';
    }
    // Non-auth errors (rate limit, network) — key might be fine
    if (status === 429) return null;
    return `Could not validate key: ${msg}`;
  }
}

function isRetryableError(err: unknown): boolean {
  if (err && typeof err === 'object') {
    const status = (err as any).status ?? (err as any).statusCode ?? (err as any).code;
    if (status === 429 || status === 529 || status === 503 || status === 500) return true;
    const msg = (err as any).message ?? '';
    if (typeof msg === 'string' && (msg.includes('429') || msg.includes('rate') || msg.includes('overloaded'))) return true;
  }
  return false;
}

export async function callLLM(
  config: LLMConfig,
  system: string,
  userMessage: string,
  maxTokens: number = 512,
  modelOverride?: string
): Promise<string> {
  const model = modelOverride ?? config.model ?? 'claude-haiku-4-5-20251001';

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await callLLMOnce(config, system, userMessage, maxTokens, model);
    } catch (err) {
      if (attempt < MAX_RETRIES && isRetryableError(err)) {
        const backoff = INITIAL_BACKOFF_MS * Math.pow(2, attempt) + Math.random() * 500;
        console.log(`[llm] Rate limited, retrying in ${(backoff / 1000).toFixed(1)}s (attempt ${attempt + 1}/${MAX_RETRIES})...`);
        await new Promise((resolve) => setTimeout(resolve, backoff));
        continue;
      }
      throw err;
    }
  }
  throw new Error('Unreachable');
}

export async function parseNaturalQuery(input: string, config?: LLMConfig): Promise<ParsedQuery> {
  const model = config?.model ?? 'claude-haiku-4-5-20251001';

  try {
    const provider = getModelProvider(model);
    let text: string;

    if (provider === 'openai') {
      text = await callOpenAI(input, model, config?.openaiApiKey);
    } else {
      text = await callAnthropic(input, model, config?.anthropicApiKey);
    }

    // Strip any markdown fencing the model might add
    const jsonStr = text.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
    let parsed = JSON.parse(jsonStr) as ParsedQuery;

    if (!parsed.query || typeof parsed.query !== 'string') {
      return { query: input };
    }

    return parsed;
  } catch (err) {
    console.error('Query parsing failed, falling back to literal search:', (err as Error).message);
    return { query: input };
  }
}

export async function disposeQueryParser(): Promise<void> {
  // No-op — API clients are stateless, nothing to dispose
}
