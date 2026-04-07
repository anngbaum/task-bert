import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { URL } from 'node:url';
import { getPglite, closePglite, initSchema, verifyDatabase, wipePgliteData } from './db/pglite-client.js';
import { openSqlite, hasColumn } from './db/sqlite-reader.js';
import { DATA_DIR } from './config.js';
import { searchFTS } from './search/fts.js';
import { searchVector } from './search/vector.js';
import { searchHybrid } from './search/hybrid.js';
import { getContextMessages } from './display/formatter.js';
import { disposeQueryParser, AVAILABLE_MODELS, validateApiKey, getApiKeyError, clearApiKeyError } from './llm/query-parser.js';
import { searchContacts, resolveContactHandleIds } from './contacts/search.js';
import { unifiedSync, syncSingleConversation, importOlderMessages } from './commands/unified-sync.js';
import { updateMetadata, refreshChatMetadata } from './commands/update-metadata.js';
import { getThread, NotFoundError } from './thread/thread.js';
import { runAgent } from './agent/engine.js';
import type { SearchOptions } from './types.js';

// --- In-memory log buffer for debug panel ---
const LOG_BUFFER_MAX = 500;
const logBuffer: { ts: string; level: string; message: string }[] = [];

function pushLog(level: string, message: string) {
  const entry = { ts: new Date().toISOString(), level, message };
  logBuffer.push(entry);
  if (logBuffer.length > LOG_BUFFER_MAX) {
    logBuffer.splice(0, logBuffer.length - LOG_BUFFER_MAX);
  }
}

function getRecentLogs(limit: number = 200) {
  return logBuffer.slice(-limit);
}

// Intercept console.log/error/warn to capture into buffer
const origLog = console.log.bind(console);
const origError = console.error.bind(console);
const origWarn = console.warn.bind(console);

console.log = (...args: unknown[]) => {
  origLog(...args);
  pushLog('info', args.map(String).join(' '));
};
console.error = (...args: unknown[]) => {
  origError(...args);
  pushLog('error', args.map(String).join(' '));
};
console.warn = (...args: unknown[]) => {
  origWarn(...args);
  pushLog('warn', args.map(String).join(' '));
};

const SYNC_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
let syncInProgress = false;
let initialSyncDone = false;
let syncTimer: ReturnType<typeof setInterval> | null = null;

// --- Sync progress tracking (shared module) ---
import { getSyncProgress, updateSyncProgress, getEmbeddingProgress } from './progress.js';

const MODEL_DEFAULTS: Record<string, string> = {
  actions: 'claude-sonnet-4-6',
  summary: 'claude-haiku-4-5-20251001',
  ask: 'claude-haiku-4-5-20251001',
};

function resolveModel(purpose: 'actions' | 'summary' | 'ask'): string {
  const modelSetting = purpose === 'actions' ? settings.actionsModel
    : purpose === 'ask' ? settings.askModel
    : settings.summaryModel;
  let model = modelSetting ?? settings.selectedModel ?? MODEL_DEFAULTS[purpose];

  // Make sure the selected model's provider actually has a key configured
  const provider = model.startsWith('gpt') ? 'openai' : 'anthropic';
  const hasKey = provider === 'openai' ? !!settings.openaiApiKey : !!settings.anthropicApiKey;
  if (!hasKey) {
    // Fall back to a model whose provider has a key
    if (settings.anthropicApiKey) {
      model = MODEL_DEFAULTS[purpose];
    } else if (settings.openaiApiKey) {
      model = purpose === 'actions' ? 'gpt-4o' : 'gpt-4o-mini';
    }
  }
  return model;
}

async function getLLMConfig(purpose: 'actions' | 'summary' | 'ask' = 'summary') {
  // If no keys yet, give the client a chance to push them
  if (!settings.anthropicApiKey && !settings.openaiApiKey) {
    await waitForApiKeys(60000);
  }

  return {
    model: resolveModel(purpose),
    actionsModel: resolveModel('actions'),
    anthropicApiKey: settings.anthropicApiKey,
    openaiApiKey: settings.openaiApiKey,
  };
}

async function runSync(mode: 'hardReset' | 'pullLatest' | 'resync' = 'pullLatest'): Promise<void> {
  if (syncInProgress) {
    console.log('[scheduler] Sync already in progress, skipping.');
    return;
  }
  syncInProgress = true;
  try {
    const result = await unifiedSync({
      mode,
      llmConfig: () => getLLMConfig('summary'),
    });
    console.log(`[scheduler] Sync done (${mode}): ${result.newMessageCount} new messages across ${result.affectedChatIds.length} chats.`);
    initialSyncDone = true;
  } catch (err) {
    console.error('[scheduler] Sync error:', err);
    initialSyncDone = true; // Mark done even on error so the UI doesn't hang
  } finally {
    syncInProgress = false;
  }
}

const PORT = 11488;
const HOST = 'localhost';

// Settings persistence
const SETTINGS_PATH = path.join(DATA_DIR, 'settings.json');

interface AppSettings {
  anthropicApiKey?: string;
  openaiApiKey?: string;
  selectedModel?: string; // legacy — migrated to per-feature models
  actionsModel?: string;   // tasks & events extraction (default: sonnet)
  summaryModel?: string;   // conversation summaries (default: haiku)
  askModel?: string;       // agent/ask mode (default: haiku)
}

function loadSettings(): AppSettings {
  try {
    if (fs.existsSync(SETTINGS_PATH)) {
      const saved = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8'));
      // Strip any API keys that were persisted by older versions
      const { anthropicApiKey, openaiApiKey, ...safeSettings } = saved;
      if (anthropicApiKey || openaiApiKey) {
        // Re-save without keys to clean up the file
        fs.writeFileSync(SETTINGS_PATH, JSON.stringify(safeSettings, null, 2), { mode: 0o600 });
        console.log('[settings] Migrated: removed API keys from settings.json (now managed by Keychain)');
      }
      return safeSettings;
    }
  } catch {
    // Ignore corrupt settings
  }
  return {};
}

// Tracks whether the client has connected (hit any endpoint). Once the client
// is connected and still no keys, there's no point waiting further.
let clientHasConnected = false;

/** Resolves once the Swift client pushes API keys, or early if the client
 *  connects without keys (meaning the user hasn't configured any). */
function waitForApiKeys(timeoutMs = 30000): Promise<void> {
  if (settings.anthropicApiKey || settings.openaiApiKey) return Promise.resolve();
  return new Promise((resolve) => {
    const interval = setInterval(() => {
      if (settings.anthropicApiKey || settings.openaiApiKey) {
        clearInterval(interval);
        clearTimeout(timer);
        console.log('[startup] API key(s) received from client.');
        resolve();
      } else if (clientHasConnected) {
        // Client is alive but has no keys — no point waiting
        clearInterval(interval);
        clearTimeout(timer);
        resolve();
      }
    }, 200);
    const timer = setTimeout(() => {
      clearInterval(interval);
      resolve();
    }, timeoutMs);
  });
}

function saveSettings(settings: AppSettings): void {
  const dir = path.dirname(SETTINGS_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  // Only persist non-sensitive settings — API keys stay in memory only
  const { anthropicApiKey, openaiApiKey, ...safeSettings } = settings;
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(safeSettings, null, 2), { mode: 0o600 });
}

let settings = loadSettings();

// --- Bearer token auth ---
const AUTH_TOKEN = crypto.randomBytes(32).toString('hex');
const AUTH_TOKEN_PATH = path.join(DATA_DIR, 'auth-token');

function writeAuthToken(): void {
  const dir = path.dirname(AUTH_TOKEN_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(AUTH_TOKEN_PATH, AUTH_TOKEN, { mode: 0o600 });
}

function checkAuth(req: http.IncomingMessage): boolean {
  const header = req.headers['authorization'];
  if (!header) return false;
  const [scheme, token] = header.split(' ');
  return scheme === 'Bearer' && token === AUTH_TOKEN;
}

// Write token immediately so clients can read it
writeAuthToken();

function corsHeaders(): Record<string, string> {
  return {};
}

function jsonResponse(
  res: http.ServerResponse,
  data: unknown,
  status: number = 200
): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    ...corsHeaders(),
  });
  res.end(body);
}

function errorResponse(
  res: http.ServerResponse,
  message: string,
  status: number = 400
): void {
  jsonResponse(res, { error: message }, status);
}

async function handleSearch(
  params: URLSearchParams,
  res: http.ServerResponse
): Promise<void> {
  const query = params.get('q');
  if (!query) {
    errorResponse(res, 'Missing required parameter: q');
    return;
  }

  const mode = (params.get('mode') || 'text') as SearchOptions['mode'];
  if (!['text', 'semantic', 'hybrid'].includes(mode)) {
    errorResponse(res, 'Invalid mode. Must be: text, semantic, or hybrid');
    return;
  }

  const limit = Math.min(parseInt(params.get('limit') || '20', 10) || 20, 100);
  const offset = Math.max(parseInt(params.get('offset') || '0', 10) || 0, 0);

  const options: SearchOptions = {
    mode,
    limit: limit + 1, // fetch one extra to detect if there are more
    offset,
    context: 0,
  };

  if (params.get('from')) options.from = params.get('from')!;
  if (params.getAll('withContact').length > 0) options.withContacts = params.getAll('withContact');
  if (params.get('groupChatName')) options.groupChatName = params.get('groupChatName')!;
  if (params.get('after')) options.after = params.get('after')!;
  if (params.get('before')) options.before = params.get('before')!;
  if (params.get('fromMe') === 'true') options.fromMe = true;
  if (params.get('toMe') === 'true') options.toMe = true;

  let results;
  switch (mode) {
    case 'text':
      results = await searchFTS(query, options);
      break;
    case 'semantic':
      results = await searchVector(query, options);
      break;
    case 'hybrid':
      results = await searchHybrid(query, options);
      break;
  }

  const hasMore = results.length > limit;
  const trimmed = hasMore ? results.slice(0, limit) : results;
  jsonResponse(res, { results: trimmed, count: trimmed.length, hasMore, mode });
}

async function handleContacts(
  res: http.ServerResponse
): Promise<void> {
  const db = await getPglite();
  const result = await db.query(`
    SELECT
      COALESCE(display_name, identifier) as name,
      array_agg(DISTINCT identifier ORDER BY identifier) as identifiers
    FROM handle
    WHERE identifier IS NOT NULL
    GROUP BY COALESCE(display_name, identifier)
    ORDER BY name
  `);
  const contacts = (result.rows as any[]).map((r) => ({
    name: r.name,
    identifiers: r.identifiers,
  }));
  jsonResponse(res, { contacts });
}

async function handleGroups(
  res: http.ServerResponse
): Promise<void> {
  const db = await getPglite();
  const result = await db.query(`
    SELECT DISTINCT display_name as name, chat_identifier
    FROM chat
    WHERE display_name IS NOT NULL AND display_name != ''
    ORDER BY name
  `);
  jsonResponse(res, { groups: result.rows.map((r: any) => ({ name: r.name, chatIdentifier: r.chat_identifier })) });
}

async function handleContactSearch(
  params: URLSearchParams,
  res: http.ServerResponse
): Promise<void> {
  const query = params.get('q');
  if (!query) {
    errorResponse(res, 'Missing required parameter: q');
    return;
  }

  const limit = Math.min(parseInt(params.get('limit') || '5', 10) || 5, 20);
  const matches = await searchContacts(query, limit);
  jsonResponse(res, { matches, count: matches.length });
}

async function handleContext(
  params: URLSearchParams,
  res: http.ServerResponse
): Promise<void> {
  const messageIdStr = params.get('messageId');
  if (!messageIdStr) {
    errorResponse(res, 'Missing required parameter: messageId');
    return;
  }

  const messageId = parseInt(messageIdStr, 10);
  if (isNaN(messageId)) {
    errorResponse(res, 'messageId must be a number');
    return;
  }

  const before = parseInt(params.get('before') || '3', 10) || 3;
  const after = parseInt(params.get('after') || '10', 10) || 10;
  const messages = await getContextMessages(messageId, before, after);

  jsonResponse(res, { messages, count: messages.length });
}

async function handleThread(
  params: URLSearchParams,
  res: http.ServerResponse
): Promise<void> {
  const messageIdStr = params.get('messageId');
  if (!messageIdStr) {
    errorResponse(res, 'Missing required parameter: messageId');
    return;
  }

  const messageId = parseInt(messageIdStr, 10);
  if (isNaN(messageId)) {
    errorResponse(res, 'messageId must be a number');
    return;
  }

  const cursor = params.get('cursor') || undefined;
  const direction = params.get('direction') as 'older' | 'newer' | undefined;

  if (cursor && !direction) {
    errorResponse(res, 'direction is required when cursor is provided');
    return;
  }
  if (direction && !['older', 'newer'].includes(direction)) {
    errorResponse(res, 'direction must be "older" or "newer"');
    return;
  }

  const before = params.get('before') ? parseInt(params.get('before')!, 10) : undefined;
  const after = params.get('after') ? parseInt(params.get('after')!, 10) : undefined;
  const limit = params.get('limit') ? parseInt(params.get('limit')!, 10) : undefined;

  try {
    const result = await getThread({ messageId, before, after, cursor, direction, limit });
    jsonResponse(res, result);
  } catch (err) {
    if (err instanceof NotFoundError) {
      errorResponse(res, err.message, 404);
      return;
    }
    throw err;
  }
}

const MAX_BODY_BYTES = 1024 * 1024; // 1 MB

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    req.on('data', (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (totalBytes > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error('Request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

function maskKey(key: string): string {
  return key.length > 12
    ? key.slice(0, 7) + '...' + key.slice(-4)
    : '***';
}

async function handleModels(res: http.ServerResponse): Promise<void> {
  const models = AVAILABLE_MODELS.map((m) => ({
    ...m,
    available: m.provider === 'anthropic'
      ? !!settings.anthropicApiKey
      : !!settings.openaiApiKey,
  }));
  jsonResponse(res, { models });
}

async function handleGetSettings(res: http.ServerResponse): Promise<void> {
  // Return settings — never send API keys over the wire (even masked).
  // The Swift client owns the keys via Keychain and pushes them on startup.
  const { anthropicApiKey, openaiApiKey, ...safeSettings } = settings;
  const apiKeyErr = getApiKeyError();
  jsonResponse(res, {
    ...safeSettings,
    hasAnthropicKey: !!anthropicApiKey,
    hasOpenaiKey: !!openaiApiKey,
    apiKeyError: apiKeyErr ? { provider: apiKeyErr.provider, message: apiKeyErr.message } : undefined,
  });
}

async function handlePutSettings(
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  clientHasConnected = true;
  const body = await readBody(req);
  let update: Partial<AppSettings>;
  try {
    update = JSON.parse(body);
  } catch {
    errorResponse(res, 'Invalid JSON body');
    return;
  }

  if (update.anthropicApiKey !== undefined) {
    settings.anthropicApiKey = update.anthropicApiKey || undefined;
    // Clear any auth error for this provider since the key changed
    const err = getApiKeyError();
    if (err?.provider === 'anthropic') clearApiKeyError();
  }
  if (update.openaiApiKey !== undefined) {
    settings.openaiApiKey = update.openaiApiKey || undefined;
    const err = getApiKeyError();
    if (err?.provider === 'openai') clearApiKeyError();
  }
  // Legacy single model
  if (update.selectedModel !== undefined) {
    settings.selectedModel = update.selectedModel || undefined;
  }
  // Per-feature models
  if (update.actionsModel !== undefined) {
    settings.actionsModel = update.actionsModel || undefined;
  }
  if (update.summaryModel !== undefined) {
    settings.summaryModel = update.summaryModel || undefined;
  }
  if (update.askModel !== undefined) {
    settings.askModel = update.askModel || undefined;
  }

  saveSettings(settings);
  jsonResponse(res, { ok: true });
}

const server = http.createServer(async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'POST' && req.method !== 'PUT') {
    errorResponse(res, 'Method not allowed', 405);
    return;
  }

  const url = new URL(req.url || '/', `http://${HOST}:${PORT}`);
  const params = url.searchParams;

  // Allow /health and /api/settings without auth
  // /health: auth-exempt for startup polling before token is read
  const authExempt = url.pathname === '/health';
  if (!authExempt && !checkAuth(req)) {
    errorResponse(res, 'Unauthorized', 401);
    return;
  }

  try {
    // PUT routes
    if (req.method === 'PUT') {
      switch (url.pathname) {
        case '/api/settings':
          await handlePutSettings(req, res);
          break;
        default:
          errorResponse(res, 'Not found', 404);
      }
      return;
    }

    // POST routes
    if (req.method === 'POST') {
      switch (url.pathname) {
        case '/api/chat-metadata/refresh': {
          const chatIdStr = params.get('chatId');
          if (!chatIdStr) {
            errorResponse(res, 'Missing required parameter: chatId');
            break;
          }
          const chatId = parseInt(chatIdStr, 10);
          if (isNaN(chatId)) {
            errorResponse(res, 'chatId must be a number');
            break;
          }
          try {
            const llmConfig = await getLLMConfig('summary');
            // Pull new messages for this chat, embed, and refresh metadata
            const { newMessages } = await syncSingleConversation(chatId, llmConfig);
            // Return the updated summary
            const db = await getPglite();
            const metaResult = await db.query('SELECT summary FROM chat_metadata WHERE chat_id = $1', [chatId]);
            const summary = metaResult.rows.length > 0 ? (metaResult.rows[0] as any).summary : null;
            jsonResponse(res, { chat_id: chatId, summary, newMessages });
          } catch (err) {
            errorResponse(res, (err as Error).message, 500);
          }
          break;
        }
        case '/api/update-metadata': {
          try {
            const llmConfig = await getLLMConfig('summary');
            const sinceParam = params.get('since');
            const since = sinceParam ? new Date(sinceParam) : undefined;
            const minMessages = parseInt(params.get('minMessages') || '1', 10);
            const count = await updateMetadata(llmConfig, { since, minMessages });
            jsonResponse(res, { updated: count });
          } catch (err) {
            errorResponse(res, (err as Error).message, 500);
          }
          break;
        }
        case '/api/tasks/create': {
          const body = await readBody(req);
          let parsed: { title?: string; date?: string; priority?: string; type?: string; trigger_hint?: string; chat_id?: number };
          try {
            parsed = JSON.parse(body);
          } catch {
            errorResponse(res, 'Invalid JSON body');
            break;
          }
          if (!parsed.title) {
            errorResponse(res, 'Missing required field: title');
            break;
          }
          try {
            const db = await getPglite();
            const priority = parsed.priority === 'high' ? 'high' : 'low';
            const type = parsed.type === 'waiting' ? 'waiting' : 'action';
            const result = await db.query(
              `INSERT INTO tasks (chat_id, title, date, priority, type, trigger_hint) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
              [parsed.chat_id ?? 0, parsed.title, parsed.date ?? null, priority, type, parsed.trigger_hint ?? null]
            );
            jsonResponse(res, { ok: true, task: result.rows[0] });
          } catch (err) {
            errorResponse(res, (err as Error).message, 500);
          }
          break;
        }
        case '/api/actions/complete': {
          const actionIdStr = params.get('id');
          if (!actionIdStr) {
            errorResponse(res, 'Missing required parameter: id');
            break;
          }
          const actionId = parseInt(actionIdStr, 10);
          if (isNaN(actionId)) {
            errorResponse(res, 'id must be a number');
            break;
          }
          try {
            const db = await getPglite();
            await db.query('UPDATE tasks SET completed = true WHERE id = $1', [actionId]);
            jsonResponse(res, { ok: true });
          } catch (err) {
            errorResponse(res, (err as Error).message, 500);
          }
          break;
        }
        case '/api/tasks/move': {
          const body = await readBody(req);
          let parsed: { id?: number; bucket?: string; date?: string | null };
          try {
            parsed = JSON.parse(body);
          } catch {
            errorResponse(res, 'Invalid JSON body');
            break;
          }
          if (!parsed.id || !parsed.bucket) {
            errorResponse(res, 'Missing required fields: id, bucket');
            break;
          }
          try {
            const db = await getPglite();
            if (parsed.bucket === 'todo') {
              await db.query('UPDATE tasks SET type = $1, date = NULL WHERE id = $2', ['action', parsed.id]);
            } else if (parsed.bucket === 'upcoming') {
              const date = parsed.date || new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
              await db.query('UPDATE tasks SET type = $1, date = $2 WHERE id = $3', ['action', date, parsed.id]);
            } else if (parsed.bucket === 'waiting') {
              await db.query('UPDATE tasks SET type = $1 WHERE id = $2', ['waiting', parsed.id]);
            } else {
              errorResponse(res, 'Invalid bucket. Must be: todo, upcoming, waiting');
              break;
            }
            jsonResponse(res, { ok: true });
          } catch (err) {
            errorResponse(res, (err as Error).message, 500);
          }
          break;
        }
        case '/api/tasks/set-priority': {
          const idStr = params.get('id');
          const priority = params.get('priority');
          if (!idStr) {
            errorResponse(res, 'Missing required parameter: id');
            break;
          }
          const id = parseInt(idStr, 10);
          if (isNaN(id)) {
            errorResponse(res, 'id must be a number');
            break;
          }
          if (priority !== 'high' && priority !== 'low') {
            errorResponse(res, 'priority must be "high" or "low"');
            break;
          }
          try {
            const db = await getPglite();
            await db.query('UPDATE tasks SET priority = $1 WHERE id = $2', [priority, id]);
            jsonResponse(res, { ok: true });
          } catch (err) {
            errorResponse(res, (err as Error).message, 500);
          }
          break;
        }
        case '/api/tasks/set-reminder': {
          const taskIdStr = params.get('id');
          const reminderId = params.get('reminderId');
          if (!taskIdStr) {
            errorResponse(res, 'Missing required parameter: id');
            break;
          }
          const taskId = parseInt(taskIdStr, 10);
          if (isNaN(taskId)) {
            errorResponse(res, 'id must be a number');
            break;
          }
          try {
            const db = await getPglite();
            await db.query('UPDATE tasks SET reminder_id = $1 WHERE id = $2', [reminderId || null, taskId]);
            jsonResponse(res, { ok: true });
          } catch (err) {
            errorResponse(res, (err as Error).message, 500);
          }
          break;
        }
        case '/api/events/delete': {
          const eventIdStr = params.get('id');
          if (!eventIdStr) {
            errorResponse(res, 'Missing required parameter: id');
            break;
          }
          const eventId = parseInt(eventIdStr, 10);
          if (isNaN(eventId)) {
            errorResponse(res, 'id must be a number');
            break;
          }
          try {
            const db = await getPglite();
            await db.query('UPDATE key_events SET removed = true WHERE id = $1', [eventId]);
            jsonResponse(res, { ok: true });
          } catch (err) {
            errorResponse(res, (err as Error).message, 500);
          }
          break;
        }
        case '/api/events/update': {
          const updateBody = await readBody(req);
          let updateParsed: { id?: number; title?: string; date?: string | null; location?: string | null };
          try {
            updateParsed = JSON.parse(updateBody);
          } catch {
            errorResponse(res, 'Invalid JSON body');
            break;
          }
          if (!updateParsed.id) {
            errorResponse(res, 'Missing required field: id');
            break;
          }
          try {
            const db = await getPglite();
            const sets: string[] = [];
            const values: any[] = [];
            let idx = 1;
            if (updateParsed.title !== undefined) {
              sets.push(`title = $${idx++}`);
              values.push(updateParsed.title);
            }
            if (updateParsed.date !== undefined) {
              sets.push(`date = $${idx++}`);
              values.push(updateParsed.date);
            }
            if (updateParsed.location !== undefined) {
              sets.push(`location = $${idx++}`);
              values.push(updateParsed.location);
            }
            if (sets.length === 0) {
              errorResponse(res, 'No fields to update');
              break;
            }
            values.push(updateParsed.id);
            await db.query(`UPDATE key_events SET ${sets.join(', ')} WHERE id = $${idx}`, values);
            jsonResponse(res, { ok: true });
          } catch (err) {
            errorResponse(res, (err as Error).message, 500);
          }
          break;
        }
        case '/api/events/message': {
          const msgEventId = params.get('id');
          if (!msgEventId) {
            errorResponse(res, 'Missing required parameter: id');
            break;
          }
          try {
            const db = await getPglite();
            const result = await db.query(
              `SELECT m.text FROM message m
               JOIN key_events ke ON ke.message_id = m.id
               WHERE ke.id = $1`,
              [parseInt(msgEventId, 10)]
            );
            const text = result.rows.length > 0 ? (result.rows[0] as any).text : null;
            jsonResponse(res, { text });
          } catch (err) {
            errorResponse(res, (err as Error).message, 500);
          }
          break;
        }
        case '/api/agent': {
          const body = await readBody(req);
          let parsed: { query?: string };
          try {
            parsed = JSON.parse(body);
          } catch {
            errorResponse(res, 'Invalid JSON body');
            break;
          }
          if (!parsed.query) {
            errorResponse(res, 'Missing required field: query');
            break;
          }
          try {
            const llmConfig = await getLLMConfig('ask');
            console.log(`[agent] Received query: "${parsed.query}"`);

            // Stream newline-delimited JSON: progress events followed by final result
            res.writeHead(200, {
              'Content-Type': 'application/x-ndjson',
              'Transfer-Encoding': 'chunked',
              ...corsHeaders(),
            });

            const onProgress = (event: import('./agent/engine.js').AgentProgressEvent) => {
              res.write(JSON.stringify({ stream: 'progress', event_type: event.type, description: event.description, tool: event.tool, result_summary: event.result_summary }) + '\n');
            };

            const result = await runAgent(parsed.query, llmConfig, onProgress);
            console.log(`[agent] Completed: ${result.tool_calls_count} tool calls, ${result.message_links.length} links`);
            res.write(JSON.stringify({ stream: 'result', answer: result.answer, message_links: result.message_links, tool_calls_count: result.tool_calls_count, data_range: result.data_range ?? null }) + '\n');
            res.end();
          } catch (err) {
            console.error('[agent] Error:', err);
            // If headers already sent, write error as ndjson
            if (res.headersSent) {
              res.write(JSON.stringify({ stream: 'error', message: (err as Error).message }) + '\n');
              res.end();
            } else {
              errorResponse(res, (err as Error).message, 500);
            }
          }
          break;
        }
        case '/api/import-older': {
          if (syncInProgress) {
            jsonResponse(res, { error: 'Sync already in progress' }, 409);
            break;
          }
          const sinceStr = params.get('since');
          if (!sinceStr) {
            errorResponse(res, 'Missing required parameter: since (ISO date)');
            break;
          }
          const sinceDate = new Date(sinceStr);
          if (isNaN(sinceDate.getTime())) {
            errorResponse(res, 'Invalid date format for since parameter');
            break;
          }
          syncInProgress = true;
          jsonResponse(res, { started: true, since: sinceDate.toISOString() });
          importOlderMessages(sinceDate)
            .then((result) => {
              console.log(`[import-older] Complete: ${result.newMessageCount} new messages.`);
            })
            .catch((err) => {
              console.error('[import-older] Failed:', err);
            })
            .finally(() => { syncInProgress = false; });
          break;
        }
        case '/api/soft-reset': {
          if (syncInProgress) {
            jsonResponse(res, { error: 'Sync already in progress' }, 409);
            break;
          }
          syncInProgress = true;
          jsonResponse(res, { started: true, mode: 'softReset' });
          (async () => {
            try {
              const db = await getPglite();
              console.log('[soft-reset] Clearing tasks, events, and chat metadata...');
              updateSyncProgress('soft-reset', 'Clearing tasks and events...', 5);
              db.exec(`DELETE FROM tasks`);
              db.exec(`DELETE FROM key_events`);
              db.exec(`DELETE FROM chat_metadata`);
              db.exec(`DELETE FROM metadata_meta`);
              console.log('[soft-reset] Re-generating metadata...');
              updateSyncProgress('metadata', 'Re-generating metadata...', 20);
              const llmConfig = await getLLMConfig('summary');
              const metadataCutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
              await updateMetadata(llmConfig, { since: metadataCutoff, minMessages: 1 });
              updateSyncProgress('done', 'Complete!', 100);
              console.log('[soft-reset] Complete.');
            } catch (err) {
              console.error('[soft-reset] Failed:', err);
            } finally {
              syncInProgress = false;
            }
          })();
          break;
        }
        case '/api/sync': {
          if (syncInProgress) {
            jsonResponse(res, { error: 'Sync already in progress' }, 409);
            break;
          }
          const days = parseInt(params.get('days') ?? '7', 10) || 7;
          const hard = params.get('hardReset') === 'true';

          if (hard) {
            // Hard reset runs in background — return immediately so the client doesn't time out
            initialSyncDone = false;
            syncInProgress = true;
            jsonResponse(res, { started: true, mode: 'hardReset' });
            unifiedSync({ mode: 'hardReset', metadataDays: days, llmConfig: () => getLLMConfig('summary') })
              .then(() => {
                console.log('[sync] Hard reset complete.');
                initialSyncDone = true;
              })
              .catch((err) => {
                console.error('[sync] Hard reset failed:', err);
                initialSyncDone = true;
              })
              .finally(() => { syncInProgress = false; });
          } else {
            // UI resync button: pull latest + metadata for all conversations in window
            syncInProgress = true;
            try {
              const result = await unifiedSync({ mode: 'resync', metadataDays: days, llmConfig: () => getLLMConfig('summary') });
              jsonResponse(res, result);
            } catch (err) {
              errorResponse(res, (err as Error).message, 500);
            } finally {
              syncInProgress = false;
            }
          }
          break;
        }
        case '/api/validate-key': {
          const body = await readBody(req);
          let payload: { provider?: string; apiKey?: string };
          try {
            payload = JSON.parse(body);
          } catch {
            errorResponse(res, 'Invalid JSON body');
            break;
          }
          const { provider, apiKey } = payload;
          if (!provider || !apiKey || (provider !== 'anthropic' && provider !== 'openai')) {
            errorResponse(res, 'Missing or invalid provider/apiKey');
            break;
          }
          const validationError = await validateApiKey(provider, apiKey);
          jsonResponse(res, { valid: !validationError, error: validationError });
          break;
        }
        default:
          errorResponse(res, 'Not found', 404);
      }
      return;
    }

    // GET routes
    switch (url.pathname) {
      case '/health': {
        const embProgress = getEmbeddingProgress();
        const apiKeyErr = getApiKeyError();
        jsonResponse(res, {
          status: 'ok',
          ready: initialSyncDone,
          syncing: syncInProgress,
          progress: syncInProgress ? getSyncProgress() : undefined,
          needsApiKeys: !settings.anthropicApiKey && !settings.openaiApiKey,
          embedding: embProgress.isRunning ? embProgress : undefined,
          apiKeyError: apiKeyErr ? { provider: apiKeyErr.provider, message: apiKeyErr.message } : undefined,
        });
        break;
      }
      case '/api/data-range': {
        try {
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
          jsonResponse(res, {
            earliest: earliestDate ? new Date(earliestDate).toISOString().split('T')[0] : null,
            latest: latestDate ? new Date(latestDate).toISOString().split('T')[0] : null,
            days_covered: daysCovered,
            total_messages: parseInt((count.rows[0] as any)?.cnt ?? '0', 10),
          });
        } catch (err) {
          errorResponse(res, (err as Error).message, 500);
        }
        break;
      }
      case '/api/search':
        await handleSearch(params, res);
        break;
      case '/api/contacts':
        await handleContacts(res);
        break;
      case '/api/groups':
        await handleGroups(res);
        break;
      case '/api/contacts/search':
        await handleContactSearch(params, res);
        break;
      case '/api/context':
        await handleContext(params, res);
        break;
      case '/api/thread':
        await handleThread(params, res);
        break;
      case '/api/settings':
        await handleGetSettings(res);
        break;
      case '/api/models':
        await handleModels(res);
        break;
      case '/api/chat-metadata': {
        const db = await getPglite();
        const metaResult = await db.query(
          `SELECT cm.chat_id, cm.summary, cm.last_updated,
                  CASE
                    WHEN c.display_name IS NOT NULL AND c.display_name != '' THEN c.display_name
                    WHEN (SELECT COUNT(*) FROM chat_handle_join _chj WHERE _chj.chat_id = c.id) > 1 THEN
                      'chat with ' || (
                        SELECT string_agg(_sub.name, ', ')
                        FROM (
                          SELECT COALESCE(_h.display_name, _h.identifier) as name
                          FROM chat_handle_join _chj2
                          JOIN handle _h ON _chj2.handle_id = _h.id
                          WHERE _chj2.chat_id = c.id
                          ORDER BY _h.id
                          LIMIT 6
                        ) _sub
                      )
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
                   WHERE cmj.chat_id = cm.chat_id) as latest_message_date,
                  (SELECT COUNT(*) FROM chat_handle_join _chj WHERE _chj.chat_id = c.id) as participant_count
           FROM chat_metadata cm
           LEFT JOIN chat c ON c.id = cm.chat_id
           ORDER BY latest_message_date DESC NULLS LAST`
        );
        jsonResponse(res, { metadata: metaResult.rows });
        break;
      }
      case '/api/actions': {
        const db = await getPglite();
        const showCompleted = params.get('completed') === 'true';
        const chatNameExpr = `CASE
                    WHEN c.display_name IS NOT NULL AND c.display_name != '' THEN c.display_name
                    WHEN (SELECT COUNT(*) FROM chat_handle_join _chj WHERE _chj.chat_id = c.id) > 1 THEN
                      'chat with ' || (
                        SELECT string_agg(_sub.name, ', ')
                        FROM (
                          SELECT COALESCE(_h.display_name, _h.identifier) as name
                          FROM chat_handle_join _chj2
                          JOIN handle _h ON _chj2.handle_id = _h.id
                          WHERE _chj2.chat_id = c.id
                          ORDER BY _h.id
                          LIMIT 6
                        ) _sub
                      )
                    ELSE (
                      SELECT COALESCE(_h2.display_name, _h2.identifier)
                      FROM chat_handle_join _chj3
                      JOIN handle _h2 ON _chj3.handle_id = _h2.id
                      WHERE _chj3.chat_id = c.id
                      LIMIT 1
                    )
                  END`;

        const eventsResult = await db.query(
          `SELECT ke.*, ${chatNameExpr} as chat_name
           FROM key_events ke
           LEFT JOIN chat c ON c.id = ke.chat_id
           ${showCompleted ? '' : 'WHERE (ke.removed = false OR ke.removed IS NULL)'}
           ORDER BY ke.date ASC NULLS LAST, ke.created_at DESC`
        );

        const tasksResult = await db.query(
          `SELECT t.*, ${chatNameExpr} as chat_name,
             CASE
               WHEN t.type = 'waiting' THEN 'waiting'
               WHEN t.type = 'action' AND t.date IS NOT NULL AND t.date > CURRENT_DATE + INTERVAL '1 day' THEN 'upcoming'
               ELSE 'todo'
             END as bucket
           FROM tasks t
           LEFT JOIN chat c ON c.id = t.chat_id
           ${showCompleted ? '' : 'WHERE t.completed = false'}
           ORDER BY
             CASE
               WHEN t.type = 'waiting' THEN 2
               WHEN t.type = 'action' AND t.date IS NOT NULL AND t.date > CURRENT_DATE + INTERVAL '1 day' THEN 1
               ELSE 0
             END,
             CASE t.priority WHEN 'high' THEN 0 ELSE 1 END,
             t.date ASC NULLS LAST,
             t.created_at DESC`
        );

        jsonResponse(res, {
          key_events: eventsResult.rows,
          tasks: tasksResult.rows,
        });
        break;
      }
      case '/api/logs': {
        const limit = parseInt(params.get('limit') || '200', 10);
        const logs = getRecentLogs(limit);
        jsonResponse(res, { logs });
        break;
      }
      case '/api/chat-leaderboard': {
        const chatIdStr = params.get('chatId');
        if (!chatIdStr) {
          errorResponse(res, 'Missing required parameter: chatId');
          break;
        }
        const chatId = parseInt(chatIdStr, 10);
        if (isNaN(chatId)) {
          errorResponse(res, 'chatId must be a number');
          break;
        }
        try {
          // Query the full SQLite chat.db for complete history (PGlite only has recent synced data)
          const sqlite = openSqlite();

          // iMessage creates duplicate handle rows for the same person (different
          // services/times), so chat_handle_join and message.handle_id can reference
          // different ROWIDs for the same identifier. Normalize everything by
          // handle.id (the phone/email) instead of ROWID.

          // Build a ROWID → identifier lookup for all handles referenced in this chat
          const handleRows = sqlite.prepare(
            `SELECT DISTINCT h.ROWID as handle_id, h.id as identifier
             FROM handle h
             WHERE h.ROWID IN (
               SELECT handle_id FROM chat_handle_join WHERE chat_id = ?
               UNION
               SELECT handle_id FROM message m
               JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
               WHERE cmj.chat_id = ? AND m.is_from_me = 0
             )`
          ).all(chatId, chatId) as { handle_id: number; identifier: string }[];
          const handleIdToIdentifier = new Map(handleRows.map(h => [h.handle_id, h.identifier]));

          // Unique participants by identifier
          const uniqueIdentifiers = [...new Set(handleRows.map(h => h.identifier))];

          // Look up display names from PGlite (populated from address book)
          const pg = await getPglite();
          const pgNames = await pg.query(
            `SELECT DISTINCT ON (identifier) identifier, COALESCE(display_name, identifier) as name
             FROM handle WHERE identifier = ANY($1)
             ORDER BY identifier, display_name NULLS LAST`,
            [uniqueIdentifiers]
          );
          const identifierToName = new Map((pgNames.rows as { identifier: string; name: string }[]).map(r => [r.identifier, r.name]));
          const participants = uniqueIdentifiers.map(identifier => ({
            identifier,
            name: identifierToName.get(identifier) ?? identifier,
          }));

          // associated_message_guid format: "p:<part>/<original_guid>"
          // Use substr + instr to extract the original guid after "/"
          // associated_message_emoji was added in macOS 14+; older versions don't have it
          const hasEmoji = hasColumn(sqlite, 'message', 'associated_message_emoji');
          const emojiSelect = hasEmoji ? 'r.associated_message_emoji as emoji,' : '';
          const emojiGroupBy = hasEmoji ? ', r.associated_message_emoji' : '';
          // Join through handle to normalize by identifier instead of ROWID
          const reactions = sqlite.prepare(
            `SELECT
               orig.is_from_me as orig_is_from_me,
               oh.id as orig_identifier,
               r.associated_message_type as reaction_type,
               ${emojiSelect}
               COUNT(*) as cnt
             FROM message r
             JOIN message orig ON orig.guid = substr(r.associated_message_guid, instr(r.associated_message_guid, '/') + 1)
             JOIN chat_message_join cmj ON cmj.message_id = orig.ROWID
             LEFT JOIN handle oh ON oh.ROWID = orig.handle_id
             WHERE cmj.chat_id = ?
               AND r.associated_message_type BETWEEN 2000 AND 2006
             GROUP BY orig.is_from_me, oh.id, r.associated_message_type${emojiGroupBy}`
          ).all(chatId) as { orig_is_from_me: number; orig_identifier: string | null; reaction_type: number; emoji: string | null; cnt: number }[];

          // Message counts per participant (excluding reactions/edits)
          const messageCounts = sqlite.prepare(
            `SELECT m.is_from_me, h.id as identifier, COUNT(*) as cnt
             FROM message m
             JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
             LEFT JOIN handle h ON h.ROWID = m.handle_id
             WHERE cmj.chat_id = ?
               AND m.associated_message_type = 0
             GROUP BY m.is_from_me, h.id`
          ).all(chatId) as { is_from_me: number; identifier: string | null; cnt: number }[];

          sqlite.close();

          jsonResponse(res, {
            participants,
            reactions: reactions.map(r => ({ ...r, orig_is_from_me: !!r.orig_is_from_me })),
            message_counts: messageCounts.map(m => ({ ...m, is_from_me: !!m.is_from_me })),
          });
        } catch (err) {
          errorResponse(res, (err as Error).message, 500);
        }
        break;
      }
      default:
        errorResponse(res, 'Not found', 404);
    }
  } catch (err) {
    console.error('Request error:', err);
    errorResponse(
      res,
      err instanceof Error ? err.message : 'Internal server error',
      500
    );
  }
});

async function start(): Promise<void> {
  let hardReset = process.argv.includes('--hard-reset');

  // Start the HTTP server immediately so health checks respond while we initialize
  server.listen(PORT, HOST, () => {
    console.log(`Bert API server running at http://${HOST}:${PORT}`);
    console.log('Endpoints:');
    console.log('  GET /api/search?q=...&mode=text|semantic|hybrid&limit=20');
    console.log('  GET /api/ask?q=...&limit=20');
    console.log('  GET /api/contacts');
    console.log('  GET /api/groups');
    console.log('  GET /api/contacts/search?q=...&limit=5');
    console.log('  GET /api/context?messageId=...&count=5');
    console.log('  GET /api/thread?messageId=...&before=25&after=25');
    console.log('  GET /api/settings');
    console.log('  PUT /api/settings');
    console.log('  POST /api/validate-key');
    console.log('  POST /api/sync');
  });

  // Initialize PGLite (after server is listening so health checks respond)
  console.log('Initializing PGLite...');
  let pg;
  try {
    pg = await getPglite();
  } catch (err) {
    console.warn('[startup] PGLite failed to open — wiping corrupted data and reinitializing.');
    await wipePgliteData();
    pg = await getPglite();
    hardReset = true;
  }
  await initSchema();
  console.log('PGLite ready.');

  // Verify database integrity — if corrupted, wipe and force hard reset
  if (!hardReset) {
    const healthy = await verifyDatabase();
    if (!healthy) {
      console.warn('[startup] Database corrupted — wiping and forcing hard reset.');
      await wipePgliteData();
      await getPglite();
      await initSchema();
      hardReset = true;
    }
  }

  // If we already have synced data and won't hard reset, let the app be usable immediately.
  // Skip this if a hard reset is pending — the UI should stay on the initializing screen
  // until the full import + metadata generation finishes.
  if (!hardReset) {
    try {
      const result = await pg.query('SELECT last_synced FROM sync_meta WHERE id = 1');
      const countResult = await pg.query('SELECT COUNT(*) as count FROM message');
      const row = countResult.rows[0] as Record<string, any> | undefined;
      const msgCount = parseInt(row ? row.count : '0', 10);
      if (result.rows.length > 0 && msgCount >= 10) {
        console.log('[startup] Existing data found — app is ready, sync will run in background.');
        initialSyncDone = true;
      }
    } catch {
      // Table may not exist yet on very first run
    }
  }

  // If database has fewer than 10 messages, force a hard refresh to repopulate
  if (!hardReset) {
    try {
      const countResult = await pg.query('SELECT COUNT(*) as count FROM message');
      const row = countResult.rows[0] as Record<string, any> | undefined;
      const msgCount = parseInt(row ? row.count : '0', 10);
      if (msgCount < 10) {
        console.warn(`[startup] Only ${msgCount} messages found — triggering hard refresh to repopulate.`);
        hardReset = true;
      }
    } catch {
      // Table may not exist yet — hard reset will handle it
    }
  }

  // Run sync on startup, then schedule hourly pull-latest
  if (hardReset) {
    console.log('[startup] Hard reset requested via --hard-reset flag.');
  }
  runSync(hardReset ? 'hardReset' : 'pullLatest').catch((err) => console.error('[scheduler] Startup sync failed:', err));
  syncTimer = setInterval(() => {
    runSync('pullLatest').catch((err) => console.error('[scheduler] Scheduled sync failed:', err));
  }, SYNC_INTERVAL_MS);
}

async function shutdown() {
  console.log('\nShutting down...');
  if (syncTimer) clearInterval(syncTimer);
  server.close();
  await disposeQueryParser();
  await closePglite();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

start().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
