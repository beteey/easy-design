# MCP Integration Design

**Date**: 2026-04-09  
**Status**: Approved  
**Goal**: Let Claude Code receive design requests from the browser in near-real-time, automatically edit source files, and report back to the page.

---

## Overview

Two processes communicate via HTTP long-poll. The existing HTTP/WS server owns the queue; a new MCP stdio server bridges Claude Code to that queue.

```
Browser (Extension)
  ↓  WebSocket  { type: 'design:request', element, userMessage }
HTTP/WS Server (:3771)
  ↓  enqueue → id = crypto.randomUUID()
  ↓  WebSocket reply: { type: 'design:queued', id }
  ↓
  GET /api/next?timeout=30000  ← MCP Server long-polls
  ↓  atomic claim → status: claimed
MCP Server (stdio, spawned by Claude Code)
  ↓  tool result → DesignRequest
Claude Code (current session, monitoring mode)
  ↓  reads source files, edits code
  ↓  complete_design_request(id, status, summary, changedFiles)
MCP Server → POST /api/complete/:id
  ↓
HTTP/WS Server → WebSocket push: { type: 'design:done', id, summary, changedFiles }
Browser shows result in chat panel
```

---

## Section 1: Data Flow & State Machine

### Types

```typescript
interface ElementContext {
  tag: string           // e.g. "button"
  id: string            // element id attribute, may be empty
  classList: string[]
  textContent: string   // trimmed, max 200 chars
  computedStyles: Record<string, string>
  sourceFile?: string   // React fiber source path, if available
  sourceLine?: number
}

type RequestStatus = 'pending' | 'claimed' | 'completed' | 'failed'

interface DesignRequest {
  id: string
  element: ElementContext
  userMessage: string
  status: RequestStatus
  createdAt: number
  claimedAt?: number
  completedAt?: number
  changedFiles?: string[]
  summary?: string
  error?: string
}
```

Note: `model` is not included in `DesignRequest`. Claude Code uses its own session model; the browser's model selector applies only to the existing direct-AI chat flow, not the MCP path.

### Queue Data Structure

```typescript
// queue.ts — singleton
pending: string[]                              // ordered FIFO id list
requestsById: Map<string, DesignRequest>       // full index including status
inFlight: Map<string, { claimedAt: number }>   // claimed but not yet completed
```

### Long-Poll Implementation (GET /api/next)

The endpoint uses an EventEmitter-based promise pattern:

```
if pending queue non-empty:
  atomically claim head (pending.shift()) → return immediately
else:
  register one-shot listener on queue EventEmitter
  race against setTimeout(timeout_ms)
  whichever fires first: claim & return request, or return null
```

Node.js single-threaded event loop ensures the `pending.shift()` + `inFlight.set()` sequence is never interleaved with another request handler. Only one MCP server instance is expected per session. If two callers hit `GET /api/next` simultaneously they will each receive a different request from the queue (safe), but only one should be running — this is a developer-discipline constraint, not enforced at the protocol level in v1.

### Atomic Claim (GET /api/next)

1. `pending.shift()` → get id
2. `inFlight.set(id, { claimedAt: now })`
3. `request.status = 'claimed'`
4. Push `design:processing` to all connected browser WebSocket clients
5. Return request

Timeout: no request within `timeout_ms` → return `null`. MCP server immediately long-polls again.

### Stale In-Flight Cleanup

A timer runs every 60 seconds. Any request in `inFlight` with `claimedAt` older than 5 minutes:
- `request.status = 'failed'`, `request.error = 'timed out'`
- Removed from `inFlight`
- Push `{ type: 'design:failed', id, error: 'timed out' }` to browser

### Late Completion — Idempotency & State Override Rules

`POST /api/complete/:id` follows these rules, in order:

| Current status | Incoming status | Action |
|----------------|-----------------|--------|
| `failed` (auto-timeout) | `completed` | **Override allowed**: write result, push `design:done` |
| `failed` (auto-timeout) | `failed` | No-op: already failed, ignore |
| `completed` | `failed` | **Override rejected**: completed is terminal, ignore |
| `completed` | `completed` | No-op: idempotent, ignore |
| `claimed` | `completed` / `failed` | Normal path, apply |

Rule summary: `failed(timeout) → completed` is the only allowed override. `completed` is a terminal state and cannot be overwritten.

### WebSocket Event State Machine

| Trigger | Browser event |
|---------|---------------|
| `enqueue()` | `{ type: 'design:queued', id }` |
| `GET /api/next` claim | `{ type: 'design:processing', id }` |
| `POST /api/complete` → `completed` | `{ type: 'design:done', id, summary, changedFiles }` |
| `POST /api/complete` → `failed` | `{ type: 'design:failed', id, error }` |
| Stale cleanup auto-fail | `{ type: 'design:failed', id, error: 'timed out' }` |
| Late completion after auto-fail | `{ type: 'design:done', id, summary, changedFiles }` |

### Browser Reconnection

`requestsById` retains all requests for 30 minutes (TTL-based cleanup).

`GET /api/requests/:id` returns:

```typescript
{
  id: string
  status: 'pending' | 'claimed' | 'completed' | 'failed'
  summary?: string
  changedFiles?: string[]
  error?: string
  createdAt: number
  claimedAt?: number
  completedAt?: number
}
```

**Browser UI on reconnect by status:**

| Status | UI | Action |
|--------|----|--------|
| `pending` | "Waiting…" | no polling needed |
| `claimed` | "Processing…" | poll `GET /api/requests/:id` every 5s (client-side); stop when `completed` or `failed`; give up and show error after 5 min (matches server stale timeout) |
| `completed` | Show summary + changedFiles | done |
| `failed` | Show error | done |

---

## Section 2: New Files & Interfaces

### File Changes

```
server/src/
  queue.ts              NEW  — queue singleton + TTL cleanup
  mcp.ts                NEW  — MCP stdio entry point (separate tsc entry point)
  app.ts                MOD  — 3 new HTTP endpoints + new WS message types
  package.json          MOD  — add @modelcontextprotocol/sdk; add "build:mcp" script
  tsconfig.build.json   MOD  — add mcp.ts as additional entry point (outDir: dist/)

.claude/
  settings.local.json         NEW  — gitignored, machine-specific MCP config
  settings.local.example.json NEW  — committed template with placeholder cwd
  settings.json               MOD  — shared config without mcpServers (moved to local)

.gitignore             MOD  — add .claude/settings.local.json
```

**settings.local.example.json** (committed as template):
```json
{
  "mcpServers": {
    "design-easily": {
      "command": "node",
      "args": ["server/dist/mcp.js"],
      "cwd": "<absolute-path-to-project-root>"
    }
  }
}
```
Developers copy this to `settings.local.json` and fill in their own `cwd`.

**settings.json approach**: machine-specific `cwd` must NOT be committed. Two options:
- Use `.claude/settings.local.json` (gitignored) for `mcpServers`; Claude Code merges local + project settings
- Or document that each developer edits `.claude/settings.json` locally and it is gitignored

Add `.claude/settings.local.json` (or `.claude/settings.json` if that file is gitignored) to `.gitignore`.

### New HTTP Endpoints (app.ts)

| Endpoint | Description |
|----------|-------------|
| `GET /api/next?timeout=30000` | Long-poll, atomic claim, returns `{ ok: true, request: DesignRequest } \| { ok: true, request: null }` |
| `POST /api/complete/:id` | Claude Code writes back result; id in path only, not body |
| `GET /api/requests/:id` | Single request status lookup for reconnection |

**POST /api/complete/:id body:**
```typescript
{
  status: 'completed' | 'failed'
  summary?: string        // required when status = 'completed'
  changedFiles?: string[] // required when status = 'completed'
  error?: string          // required when status = 'failed'; server rejects 400 if missing
}
```

### New WebSocket Message Types

**ClientMessage (browser → server):**
```typescript
| { type: 'design:request'; element: ElementContext; userMessage: string }
// id NOT included — generated by server
```

**ServerMessage (server → browser):**
```typescript
| { type: 'design:queued';     id: string }
// Note: browser already has element/userMessage since it sent them — no need to echo back
| { type: 'design:processing'; id: string }
| { type: 'design:done';       id: string; summary: string; changedFiles: string[] }
| { type: 'design:failed';     id: string; error: string }
```

### MCP Tools (mcp.ts)

**`watch_design_requests`**
- Input: `{ timeout_ms?: number }` (default: 30000)
- Output: `DesignRequest | null`
- Behavior: `GET http://127.0.0.1:3771/api/next?timeout=...`
- Error: if server unreachable, return error message to Claude Code ("请先启动 server: npm run dev:server")

**`complete_design_request`**
- Input: `{ id: string; status: 'completed' | 'failed'; summary?: string; changedFiles?: string[]; error?: string }`
- Output: `{ ok: boolean }`
- Behavior: `POST http://127.0.0.1:3771/api/complete/:id`
- Error: if server unreachable, return error message to Claude Code; monitoring loop continues

### Claude Code Configuration

```json
// .claude/settings.local.json (gitignored — each developer sets their own)
{
  "mcpServers": {
    "design-easily": {
      "command": "node",
      "args": ["server/dist/mcp.js"],
      "cwd": "<absolute-path-to-project-root>"
    }
  }
}
```

---

## Section 3: Claude Code Workflow

### Monitoring Mode

Triggered by user instruction ("开始监听设计请求"). Claude Code enters monitoring mode **within the current session** — it repeatedly calls the MCP tool to consume requests serially, one at a time, until the user stops it or the session ends. This is not a background daemon.

### Main Loop (serial consumption)

```
loop:
  try:
    request = watch_design_requests(timeout_ms=30000)
    if request is null → continue loop  // timeout, no requests

    # Locate source file
    if request.element.sourceFile exists:
      read that file directly
    else:
      search codebase using element.tag / classList / textContent
      pick most relevant candidate file

    analyze element context + userMessage
    edit file(s)

    complete_design_request({
      id: request.id,
      status: 'completed',
      summary: "<human-readable description of the change>",
      changedFiles: ["src/components/..."]
      // line number is optional in summary, not part of the stable contract
    })

    terminal: ✓ [done] <file> — <summary>

  catch any uncaught exception:
    attempt complete_design_request({ id, status: 'failed', error: err.message })
    terminal: ✗ [failed] <error>
    continue loop  // failure does NOT break the monitoring loop
```

### Stopping

- User says "停止监听" → loop exits
- Claude Code session closes → MCP server process terminates, loop ends naturally

---

## Startup

```bash
# Terminal: start HTTP/WS server
npm run dev:server

# Claude Code session: MCP server is auto-spawned on session start
# If HTTP/WS server is not yet running, watch_design_requests returns an error;
# Claude Code prompts user to run npm run dev:server first.
# User: "开始监听设计请求" → Claude Code enters monitoring loop
```

---

## Out of Scope (v1)

- Authentication / multi-user
- Persistent queue across server restarts
- Parallel request processing
- Extension UI changes (existing inspect panel chat unchanged)
- Distributed / multi-instance deployment
