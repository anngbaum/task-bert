# Bert Security Assessment

**Date:** 2026-04-02 (updated after remediation)
**Scope:** Full application — Swift macOS client, Node.js backend server, agent/LLM layer, MCP server, ETL pipeline, build scripts
**Methodology:** Static code review of all source files + configuration audit

---

## Executive Summary

Bert is a locally-hosted iMessage search engine with a native macOS frontend and a bundled Node.js backend. It processes highly sensitive personal data (private messages), transmits subsets to third-party LLM APIs, and exposes an agent interface via MCP. The attack surface is broader than a typical local-only app due to the HTTP API, LLM agent with tool access, and MCP server exposure.

Three critical findings have been remediated in this session: API keys moved to macOS Keychain, bearer token auth added to the HTTP API and MCP server.

**Critical findings: 3 (all resolved)** | **High: 6 (1 partially mitigated)** | **Medium: 5** | **Low: 4 (1 resolved)**

---

## CRITICAL

### C-1: API Keys Stored in Plaintext on Disk ~~with World-Readable Permissions~~

**Status: RESOLVED**

**File:** `Bert/Bert/Services/KeychainManager.swift`, `src/server.ts:150-158`
**Description:** ~~Anthropic and OpenAI API keys were written to `settings.json` as unencrypted plaintext JSON via `fs.writeFileSync`. The file inherited default `umask` permissions (`0644` — world-readable).~~

**Remediation applied:**
- API keys are now stored in macOS Keychain via `Security.framework` (`KeychainManager.swift`). The Swift client saves/loads keys using `SecItemAdd`/`SecItemCopyMatching` and pushes them to the server in memory on each launch.
- The Node server no longer persists API keys to disk. `saveSettings()` strips `anthropicApiKey` and `openaiApiKey` before writing. `loadSettings()` includes a migration that removes any keys left by older versions.
- `settings.json` is now written with explicit `mode: 0o600`.
- `GET /api/settings` no longer returns API keys (even masked) — it returns `hasAnthropicKey`/`hasOpenaiKey` booleans instead.
- The previously-exposed key in `data/settings.json` has been removed.

---

### C-2: ~~No~~ Authentication on the HTTP API Server

**Status: RESOLVED**

**File:** `src/server.ts:163-181, 460-463`
**Description:** ~~The HTTP server on port `11488` had zero authentication.~~

**Remediation applied:**
- The server generates a cryptographically random 32-byte bearer token at startup (`crypto.randomBytes(32).toString('hex')`).
- The token is written to `DATA_DIR/auth-token` with `0600` permissions.
- All API requests (except `/health`) must include `Authorization: Bearer <token>` or receive a `401 Unauthorized` response.
- `/health` is exempt to allow startup polling before the token is read.
- The Swift client (`APIClient.swift`) reads the token from disk, caches it, and includes it in all requests. On `401`, it reloads the token and retries once (handles server restart).

---

### C-3: ~~MCP Server Exposes Full Message History Without Authentication~~

**Status: RESOLVED**

**File:** `src/mcp-server.ts:15-82`
**Description:** ~~The MCP server exposed powerful tools without any authentication.~~

**Remediation applied:**
- The MCP server reads the bearer token from `DATA_DIR/auth-token` at startup.
- All `apiGet()`, `apiPost()`, and `callAgent()` calls include the `Authorization: Bearer <token>` header.
- On `401`, the MCP server reloads the token from disk and retries once (handles server restart).
- MCP tools are now gated by the same auth as all other API consumers.

**Remaining consideration:** MCP tool permissions are not scoped — any MCP client with the token has full access. Consider adding per-tool authorization if the MCP server is exposed to less-trusted clients.

---

## HIGH

### H-1: ~~No~~ Request Body Size Limit — Denial of Service

**Status: RESOLVED**

**File:** `src/server.ts:376-392`
**Description:** ~~The `readBody()` function concatenated all incoming chunks into memory with no size limit.~~

**Remediation applied:**
- `readBody()` now tracks total bytes received and destroys the request if it exceeds `MAX_BODY_BYTES` (1 MB), rejecting with a "Request body too large" error.

---

### H-2: No CSRF Protection — Cross-Origin State Mutation

**Status: MITIGATED by C-2**

**File:** `src/server.ts:450-470`
**Description:** ~~POST and PUT endpoints accepted requests without origin validation or CSRF tokens.~~

**Current state:** Bearer token auth (C-2) effectively mitigates CSRF. A cross-origin request from a malicious webpage cannot include the `Authorization: Bearer <token>` header because:
1. The token is stored on disk at `0600` — JavaScript in a browser cannot read it.
2. `fetch()` with `no-cors` mode cannot set custom `Authorization` headers.
3. Preflight (`OPTIONS`) requests would fail since the server doesn't return CORS headers.

**Residual risk:** Low. Only exploitable if the attacker already has the bearer token, which requires local filesystem access.

---

### H-3: Private Message Data Sent to Third-Party LLM APIs

**Status: Open**

**Files:** `src/commands/update-metadata.ts:113-121`, `src/commands/update-metadata.ts:354-363`, `src/llm/query-parser.ts`, `src/agent/engine.ts`
**Description:** The app sends message content (including sender names, timestamps, and full text) to Anthropic or OpenAI APIs for summarization, action extraction, and agent queries. Users may not realize their private conversations are transmitted to third parties.

**Recommendation:**
- Display a clear, prominent disclosure before enabling LLM features.
- Offer a "local-only" mode that disables summarization/actions entirely.
- Consider supporting local LLMs (e.g., Ollama) for privacy-sensitive users.

---

### H-4: ~~LLM Agent Can Fetch Arbitrary Messages by ID Without Access Control~~

**Status: RESOLVED**

**File:** `src/agent/engine.ts`
**Description:** ~~The agent extracted `[[MSG-<id>]]` references from LLM output and fetched arbitrary messages from the database.~~

**Remediation applied:**
- MSG-ID resolution now only matches against `collectedLinks` — the set of messages already seen in search results and context expansions during the current session.
- If the LLM references an ID that didn't appear in tool results, it is silently ignored (no DB fetch).
- Applied to both the Anthropic and OpenAI agent branches.

---

### H-5: LLM Prompt Injection via User Query (Agent)

**Status: Open**

**File:** `src/agent/engine.ts:396-398`
**Description:** The user's query is passed directly as the `user` message content to the LLM without sanitization. An attacker can inject system-prompt-overriding instructions.

**Recommendation:**
- Use structured message formats (XML tags, delimiters) to clearly separate user input from system instructions.
- Validate tool call arguments against expected schemas before execution.

---

### H-6: ~~Unauthenticated~~ Debug Logs Endpoint Leaks Operational Data

**Status: PARTIALLY MITIGATED by C-2**

**File:** `src/server.ts:36-52`
**Description:** All console output is captured into an in-memory buffer and exposed via `/api/logs`. Logs contain user queries, search parameters, tool call details, sync status, and error messages.

**Current state:** The endpoint now requires bearer token auth (C-2), so unauthenticated access is blocked. However, any authenticated client (including the MCP server) can still read all logs, which may contain sensitive query content.

**Remaining recommendation:**
- Filter sensitive data (queries, contact names) from log entries before buffering.

---

## MEDIUM

### M-1: LLM Prompt Injection via iMessage Content (Indirect)

**Status: Open**

**Files:** `src/commands/update-metadata.ts:113-121`, `src/commands/update-metadata.ts:354-363`
**Description:** Raw iMessage text is interpolated directly into LLM prompts for summarization and action extraction with no escaping.

**Recommendation:**
- Use structured message formats (XML tags) to separate user content from instructions.
- Validate LLM output against expected schemas.

---

### M-2: SQL Injection via String Interpolation in SQLite Queries

**Status: Open**

**Files:** `src/etl/extract.ts:37,77,115`, `src/etl/link-preview.ts:66-69`
**Description:** Multiple SQLite queries construct WHERE clauses by directly interpolating the output of `dateToImessageNano()` into SQL strings instead of using parameterized placeholders.

**Recommendation:**
- Convert all interpolated values to parameterized queries using `?` placeholders.

---

### M-3: Unvalidated LLM JSON Output Parsed as Trusted Data

**Status: Open**

**Files:** `src/llm/query-parser.ts:226-228`, `src/commands/update-metadata.ts:371-396`
**Description:** JSON from LLM responses is parsed with `JSON.parse()` and cast to TypeScript types without runtime schema validation.

**Recommendation:**
- Validate LLM output against a strict schema (e.g., using Zod) before processing.

---

### M-4: Error Messages Leak Internal Details

**Status: Open**

**File:** `src/server.ts`
**Description:** Unhandled errors return the raw `Error.message` to the client. Now requires auth to access, but authenticated clients still see internal details.

**Recommendation:**
- Log the full error server-side but return a generic message to the client.

---

### M-5: `ServerManager` Trusts Any Process on Port 11488

**Status: PARTIALLY MITIGATED by C-2**

**File:** `Bert/Bert/Services/ServerManager.swift:34,83-88`
**Description:** The Swift client accepts any HTTP 200 response on `localhost:11488/health` as proof the legitimate server is running.

**Current state:** Bearer token auth (C-2) significantly reduces this risk. Even if a rogue process binds port 11488 first and responds to `/health`, it won't have the valid bearer token. The Swift client's subsequent authenticated API calls would fail with `401`, and the rogue server cannot read the token file (written at `0600` by the real server). However, a rogue process could still prevent the real server from binding the port (denial of service).

**Remaining recommendation:**
- Consider using a Unix domain socket instead of TCP to eliminate port-squatting entirely.

---

## LOW

### L-1: ~~Key Masking Leaks Partial Key Material~~

**Status: RESOLVED**

**File:** `src/server.ts`
**Description:** ~~The `maskKey()` function exposed the first 7 and last 4 characters of API keys over the API.~~

**Remediation applied:** `GET /api/settings` no longer returns API keys at all — it returns boolean `hasAnthropicKey`/`hasOpenaiKey` flags. Key masking for the UI is now done client-side in `SettingsView.swift` using keys read directly from Keychain (never sent over the wire).

---

### L-2: No Rate Limiting on Any Endpoint

**Status: Open (reduced severity)**

**Description:** No rate limiting is implemented. Now requires bearer token auth, so only authenticated clients can trigger expensive operations.

**Recommendation:**
- Add basic rate limiting on `/api/agent`, `/api/sync`, and `/api/search?mode=semantic`.

---

### L-3: Unsafe Binary Format Parsing with Insufficient Bounds Checking

**Status: Open**

**Files:** `src/etl/transform.ts:20-71`, `src/etl/link-preview.ts:18-56`, `src/parsers/link-preview.ts:60-82`
**Description:** NSAttributedString and NSKeyedArchiver binary data is parsed with limited bounds checking.

**Recommendation:**
- Add comprehensive bounds checking on length fields.
- Validate UTF-8 output before further processing.

---

### L-4: Environment Variable Path Traversal in DATA_DIR

**Status: Open**

**File:** `src/config.ts:9-14`
**Description:** `DATA_DIR` is set from environment variables without path normalization or validation.

**Recommendation:**
- Validate that `DATA_DIR` resolves to an expected location under the user's home directory.

---

## Additional Observations

### Positive Security Properties
- **Read-only SQLite access:** The source `chat.db` is opened in read-only mode (`{ readonly: true }`), preventing corruption of the iMessage database.
- **Parameterized queries (PGlite):** All PGlite database queries use parameterized placeholders (`$1`, `$2`, etc.).
- **Localhost binding:** The server binds to `localhost` only, not `0.0.0.0`.
- **Bearer token auth:** All API endpoints (except `/health`) require a per-session bearer token, written to disk at `0600`.
- **Keychain storage:** API keys are stored in macOS Keychain, encrypted at rest, scoped to the app.
- **No keys over the wire:** `GET /api/settings` returns boolean key-presence flags, not key material.
- **Input validation:** Numeric parameters are parsed with `parseInt()` and validated with `isNaN()` checks.
- **Limit clamping:** Search `limit` is capped at 100 (server) and 30 (agent).
- **CORS headers removed:** `corsHeaders()` returns `{}`. Combined with bearer token auth, CSRF is effectively blocked.
- **Gitignore configured:** `.env` and `data/` (including `auth-token`, `settings.json`) are properly gitignored.
- **Agent iteration limit:** The LLM agent is capped at 10 tool call iterations.
- **Auth token auto-retry:** Both the Swift client and MCP server automatically reload the token and retry on `401`, handling server restarts gracefully.

### Items Not In Scope
- Network security of the LLM API calls (handled by the Anthropic/OpenAI SDKs over HTTPS)
- macOS sandboxing and code signing (build configuration not reviewed)
- Supply chain security of npm dependencies (beyond noting `tar` CVEs)
- Physical security of the host machine

---

## Remediation Priority

| Priority | Finding | Effort | Status |
|----------|---------|--------|--------|
| 1 | C-2: Add bearer token auth to API | 1-2 hrs | **Resolved** |
| 2 | C-1: Move keys to Keychain + fix file perms | 2-4 hrs | **Resolved** |
| 3 | C-3: Auth-gate MCP server tools | 1-2 hrs | **Resolved** |
| 4 | H-1: Add body size limit | 15 min | **Resolved** |
| 5 | H-2: Add CSRF protection | 30 min | **Mitigated by C-2** |
| 6 | H-4: Restrict agent MSG-ID fetching | 1 hr | **Resolved** |
| 7 | H-3: Add LLM data disclosure | 1-2 hrs | Open |
| 8 | H-5: Harden agent prompt boundary | 1-2 hrs | Open |
| 9 | H-6: Scrub sensitive data from logs | 1 hr | **Partially mitigated by C-2** |
| 10 | M-2: Fix SQL string interpolation | 30 min | Open |
| 11 | M-3: Validate LLM JSON output | 1-2 hrs | Open |
| 12 | M-4: Sanitize error messages | 30 min | Open |
| 13 | M-1: Harden LLM prompts | 1-2 hrs | Open |
| 14 | M-5: Verify server identity | 1 hr | **Partially mitigated by C-2** |
| 15 | L-1: Reduce key exposure in masking | 5 min | **Resolved** |
| 16 | L-2: Add rate limiting | 1-2 hrs | Open |
| 17 | L-3: Harden binary parsers | 1-2 hrs | Open |
| 18 | L-4: Validate DATA_DIR path | 15 min | Open |

---

## Changes from Previous Assessment (2026-03-22)

- **C-2 (old): Wildcard CORS** — RESOLVED (prior session). `corsHeaders()` now returns `{}`.
- **C-1: API keys** — **RESOLVED** this session. Keys moved to macOS Keychain. Server no longer persists keys to disk. Settings file written at `0600`. Old key removed from `data/settings.json`.
- **C-2: API auth** — **RESOLVED** this session. Bearer token auth added. Token generated per-session via `crypto.randomBytes`, stored at `0600`.
- **C-3: MCP server auth** — **RESOLVED** this session. MCP server reads and sends bearer token on all API calls. Auto-retries on `401`.
- **H-2: CSRF** — **MITIGATED** by bearer token auth (C-2). Cross-origin requests cannot include the `Authorization` header.
- **H-6: Debug logs** — **PARTIALLY MITIGATED** by bearer token auth. Endpoint now requires auth.
- **M-5: Server identity** — **PARTIALLY MITIGATED** by bearer token auth. Rogue servers can't forge valid tokens.
- **L-1: Key masking** — **RESOLVED** this session. API no longer returns key material; UI masks from Keychain directly.
- **Rename:** `SearchService` renamed to `APIClient` across the Swift codebase to better reflect its role as the centralized API layer.
