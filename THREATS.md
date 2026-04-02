# Bert Security Assessment

**Date:** 2026-04-02
**Scope:** Full application — Swift macOS client, Node.js backend server, agent/LLM layer, MCP server, ETL pipeline
**Methodology:** Static code review of all source files + configuration audit

---

## Executive Summary

Bert is a locally-hosted iMessage search engine with a native macOS frontend and a bundled Node.js backend. It processes highly sensitive personal data (private messages), transmits subsets to third-party LLM APIs, and exposes an agent interface via MCP.

**Open findings: 0 critical | 2 high | 5 medium | 3 low**

---

## HIGH

### H-1: Private Message Data Sent to Third-Party LLM APIs

**Files:** `src/commands/update-metadata.ts`, `src/llm/query-parser.ts`, `src/agent/engine.ts`
**Description:** The app sends message content (including sender names, timestamps, and full text) to Anthropic or OpenAI APIs for summarization, action extraction, and agent queries. Users may not realize their private conversations are transmitted to third parties.

**Recommendation:**
- Display a clear, prominent disclosure before enabling LLM features.
- Offer a "local-only" mode that disables summarization/actions entirely.
- Consider supporting local LLMs (e.g., Ollama) for privacy-sensitive users.

---

### H-2: LLM Prompt Injection via User Query (Agent)

**File:** `src/agent/engine.ts`
**Description:** The user's query is passed directly as the `user` message content to the LLM without sanitization. An attacker can inject system-prompt-overriding instructions to manipulate search filters, bypass constraints, or exfiltrate broader data than intended.

**Recommendation:**
- Use structured message formats (XML tags, delimiters) to clearly separate user input from system instructions.
- Validate tool call arguments against expected schemas before execution.

---

## MEDIUM

### M-1: LLM Prompt Injection via iMessage Content (Indirect)

**Files:** `src/commands/update-metadata.ts:113-121`, `src/commands/update-metadata.ts:354-363`
**Description:** Raw iMessage text is interpolated directly into LLM prompts for summarization and action extraction with no escaping. A crafted inbound message could manipulate summaries or fabricate/suppress action items.

**Recommendation:**
- Use structured message formats (XML tags) to separate user content from instructions.
- Validate LLM output against expected schemas.

---

### M-2: SQL Injection via String Interpolation in SQLite Queries

**Files:** `src/etl/extract.ts:37,77,115`, `src/etl/link-preview.ts:66-69`
**Description:** Multiple SQLite queries construct WHERE clauses by directly interpolating the output of `dateToImessageNano()` into SQL strings instead of using parameterized placeholders. The immediate risk is low (value is always computed from a `Date` object), but the pattern is fragile.

**Recommendation:**
- Convert all interpolated values to parameterized queries using `?` placeholders.

---

### M-3: Unvalidated LLM JSON Output Parsed as Trusted Data

**Files:** `src/llm/query-parser.ts:226-228`, `src/commands/update-metadata.ts:371-396`
**Description:** JSON from LLM responses is parsed with `JSON.parse()` and cast to TypeScript types without runtime schema validation. Arbitrary properties pass through unchecked.

**Recommendation:**
- Validate LLM output against a strict schema (e.g., using Zod) before processing.

---

### M-4: Error Messages Leak Internal Details

**File:** `src/server.ts`
**Description:** Unhandled errors return the raw `Error.message` to the client, potentially leaking internal file paths, database errors, or library versions.

**Recommendation:**
- Log the full error server-side but return a generic message to the client.

---

### M-5: Debug Logs May Contain Sensitive Query Content

**File:** `src/server.ts:36-52`
**Description:** All console output is captured into an in-memory buffer and exposed via `/api/logs`. Logs may contain user queries, contact names, and search parameters. The endpoint requires bearer token auth, but any authenticated client (including MCP) can read them.

**Recommendation:**
- Filter sensitive data (queries, contact names) from log entries before buffering.

---

## LOW

### L-1: No Rate Limiting on Endpoints

**Description:** No rate limiting is implemented. Bearer token auth limits access to authenticated clients, but a compromised client could still trigger expensive operations rapidly.

**Recommendation:**
- Add basic rate limiting on `/api/agent`, `/api/sync`, and `/api/search?mode=semantic`.

---

### L-2: Unsafe Binary Format Parsing with Insufficient Bounds Checking

**Files:** `src/etl/transform.ts:20-71`, `src/etl/link-preview.ts:18-56`, `src/parsers/link-preview.ts:60-82`
**Description:** NSAttributedString and NSKeyedArchiver binary data is parsed with limited bounds checking. Practical risk is low since the data comes from Apple's iMessage database.

**Recommendation:**
- Add comprehensive bounds checking on length fields.
- Validate UTF-8 output before further processing.

---

### L-3: Environment Variable Path Traversal in DATA_DIR

**File:** `src/config.ts:9-14`
**Description:** `DATA_DIR` is set from environment variables without path normalization. Requires local environment control to exploit.

**Recommendation:**
- Validate that `DATA_DIR` resolves to an expected location under the user's home directory.

---

## Positive Security Properties

- **Bearer token auth:** All API endpoints (except `/health`) require a per-session cryptographic token, written to disk at `0600`. Both the Swift client and MCP server auto-retry on `401` after server restarts.
- **Keychain storage:** API keys stored in macOS Keychain, encrypted at rest, never persisted to disk or sent over the API.
- **Read-only SQLite access:** The source `chat.db` is opened in read-only mode.
- **Parameterized queries (PGlite):** All PGlite queries use parameterized placeholders.
- **Localhost binding:** The server binds to `localhost` only.
- **CORS + auth:** No CORS headers returned; bearer token requirement blocks cross-origin attacks.
- **Agent MSG-ID scoping:** The LLM agent can only resolve message IDs that appeared in search results or context from the current session.
- **Request body limit:** `readBody()` enforces a 1 MB cap.
- **Limit clamping:** Search capped at 100, agent at 30 results.
- **Agent iteration limit:** 10 tool call iterations max.
- **Gitignore:** `.env`, `data/` (including `auth-token`, `settings.json`) are excluded from version control.

---

## Remediation Priority

| Priority | Finding | Effort |
|----------|---------|--------|
| 1 | H-1: Add LLM data disclosure | 1-2 hrs |
| 2 | H-2: Harden agent prompt boundary | 1-2 hrs |
| 3 | M-2: Fix SQL string interpolation | 30 min |
| 4 | M-3: Validate LLM JSON output | 1-2 hrs |
| 5 | M-4: Sanitize error messages | 30 min |
| 6 | M-1: Harden LLM prompts | 1-2 hrs |
| 7 | M-5: Filter sensitive data from logs | 1 hr |
| 8 | L-1: Add rate limiting | 1-2 hrs |
| 9 | L-2: Harden binary parsers | 1-2 hrs |
| 10 | L-3: Validate DATA_DIR path | 15 min |

---

## Resolved (2026-04-02)

The following were identified and fixed during this assessment:

- **API keys on disk (was Critical):** Moved to macOS Keychain. Server strips keys before writing `settings.json`. API returns boolean flags instead of key material.
- **Unauthenticated API (was Critical):** Bearer token auth added. Random 32-byte token generated per session, stored at `0600`. Required on all endpoints except `/health`.
- **Unauthenticated MCP server (was Critical):** MCP server reads and sends bearer token on all API calls.
- **No request body limit (was High):** `readBody()` enforces 1 MB max, destroys connection on overflow.
- **CSRF (was High):** Mitigated by bearer token auth — cross-origin requests cannot include the `Authorization` header.
- **Arbitrary message fetch via LLM (was High):** Agent MSG-ID resolution now only matches messages from search results and context in the current session.
- **Server identity spoofing (was Medium):** Bearer token auth prevents rogue servers from intercepting authenticated traffic.
- **Key masking leak (was Low):** API no longer returns key material; masking done client-side from Keychain.
- **Wildcard CORS (was Critical, prior session):** `corsHeaders()` returns `{}`.
