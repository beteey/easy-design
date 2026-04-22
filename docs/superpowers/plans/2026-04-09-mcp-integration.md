# MCP Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an MCP stdio server that lets Claude Code receive design requests from the browser in near-real-time, edit source files, and report results back via WebSocket.

**Architecture:** HTTP/WS server (port 3771) owns an in-memory queue; browser sends `design:request` via WebSocket, server enqueues and replies `design:queued`. A separate MCP stdio process (spawned by Claude Code) long-polls `GET /api/next` to atomically claim requests, then calls `POST /api/complete/:id` when done. The two processes share no memory — the HTTP interface is the contract between them.

**Tech Stack:** TypeScript ESM, Node.js, Express, `ws`, `@modelcontextprotocol/sdk`, vitest

**Spec:** `docs/superpowers/specs/2026-04-09-mcp-integration-design.md`

---

## File Map

| File | Status | Responsibility |
|------|--------|----------------|
| `server/src/queue.ts` | NEW | In-memory queue singleton: enqueue, dequeue (long-poll), complete, stale cleanup |
| `server/src/mcp.ts` | NEW | MCP stdio entry point — `watch_design_requests` + `complete_design_request` tools |
| `server/src/app.ts` | MODIFY | Add `design:request` WS handler + 3 HTTP endpoints |
| `server/tsconfig.build.json` | MODIFY | Add `mcp.ts` as second entry point |
| `server/package.json` | MODIFY | Add `@modelcontextprotocol/sdk` dep + `start:mcp` script |
| `tests/unit/queue.spec.ts` | NEW | Unit tests for queue logic |
| `tests/api/06-design-queue.spec.ts` | NEW | Integration tests for 3 new HTTP endpoints + WS flow |
| `.claude/settings.local.example.json` | NEW | Template for per-developer MCP config |
| `.gitignore` | MODIFY | Ignore `.claude/settings.local.json` |

---

## Task 1: queue.ts — In-Memory Queue Singleton

**Files:**
- Create: `server/src/queue.ts`
- Create: `tests/unit/queue.spec.ts`

### Step 1.1 — Write failing unit tests

Create `tests/unit/queue.spec.ts`:

```typescript
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { queue } from '../../server/src/queue.js'

beforeEach(() => queue._resetForTest())
afterEach(() => vi.useRealTimers())

describe('queue — enqueue', () => {
  it('creates a request with pending status and a UUID id', () => {
    const element = { tag: 'button', id: '', classList: [], textContent: 'Click', computedStyles: {} }
    const req = queue.enqueue(element, 'make it red')
    expect(req.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(req.status).toBe('pending')
    expect(req.userMessage).toBe('make it red')
    expect(req.element).toEqual(element)
  })
})

describe('queue — dequeue', () => {
  it('returns and claims a pending request immediately', async () => {
    const element = { tag: 'div', id: '', classList: [], textContent: '', computedStyles: {} }
    const enqueued = queue.enqueue(element, 'change color')
    const claimed = await queue.dequeue(1000)
    expect(claimed?.id).toBe(enqueued.id)
    expect(claimed?.status).toBe('claimed')
    expect(claimed?.claimedAt).toBeTypeOf('number')
  })

  it('returns null after timeout when queue is empty', async () => {
    const result = await queue.dequeue(50)
    expect(result).toBeNull()
  })

  it('resolves as soon as an item is enqueued while waiting', async () => {
    const element = { tag: 'span', id: '', classList: [], textContent: '', computedStyles: {} }
    const dequeuePromise = queue.dequeue(5000)
    queue.enqueue(element, 'add padding')
    const result = await dequeuePromise
    expect(result).not.toBeNull()
    expect(result?.status).toBe('claimed')
  })
})

describe('queue — complete', () => {
  it('marks claimed request as completed and stores result', async () => {
    const element = { tag: 'div', id: '', classList: [], textContent: '', computedStyles: {} }
    queue.enqueue(element, 'fix layout')
    await queue.dequeue(1000)
    const req = queue.getAll()[0]!
    const changed = queue.complete(req.id, {
      status: 'completed',
      summary: 'Increased padding to 16px',
      changedFiles: ['src/Foo.tsx'],
    })
    expect(changed).toBe(true)
    expect(queue.getById(req.id)?.status).toBe('completed')
    expect(queue.getById(req.id)?.summary).toBe('Increased padding to 16px')
  })

  it('marks claimed request as failed and stores error', async () => {
    const element = { tag: 'div', id: '', classList: [], textContent: '', computedStyles: {} }
    queue.enqueue(element, 'fix it')
    await queue.dequeue(1000)
    const req = queue.getAll()[0]!
    queue.complete(req.id, { status: 'failed', error: 'file not found' })
    expect(queue.getById(req.id)?.status).toBe('failed')
    expect(queue.getById(req.id)?.error).toBe('file not found')
  })
})

describe('queue — override rules', () => {
  async function makeFailedRequest(): Promise<string> {
    const element = { tag: 'div', id: '', classList: [], textContent: '', computedStyles: {} }
    queue.enqueue(element, 'test')
    const req = await queue.dequeue(1000)
    // Manually mark as failed (simulating auto-timeout)
    const r = queue.getById(req!.id)!
    r.status = 'failed'
    r.error = 'timed out'
    return r.id
  }

  it('allows failed(timeout) → completed override', async () => {
    const id = await makeFailedRequest()
    const changed = queue.complete(id, {
      status: 'completed',
      summary: 'Fixed it anyway',
      changedFiles: ['src/A.tsx'],
    })
    expect(changed).toBe(true)
    expect(queue.getById(id)?.status).toBe('completed')
  })

  it('rejects failed → failed (no-op)', async () => {
    const id = await makeFailedRequest()
    const changed = queue.complete(id, { status: 'failed', error: 'another error' })
    expect(changed).toBe(false)
    expect(queue.getById(id)?.error).toBe('timed out')
  })

  it('rejects completed → failed (terminal)', async () => {
    const element = { tag: 'div', id: '', classList: [], textContent: '', computedStyles: {} }
    queue.enqueue(element, 'x')
    await queue.dequeue(1000)
    const req = queue.getAll()[0]!
    queue.complete(req.id, { status: 'completed', summary: 'done', changedFiles: [] })
    const changed = queue.complete(req.id, { status: 'failed', error: 'oops' })
    expect(changed).toBe(false)
    expect(queue.getById(req.id)?.status).toBe('completed')
  })

  it('is idempotent for completed → completed', async () => {
    const element = { tag: 'div', id: '', classList: [], textContent: '', computedStyles: {} }
    queue.enqueue(element, 'x')
    await queue.dequeue(1000)
    const req = queue.getAll()[0]!
    queue.complete(req.id, { status: 'completed', summary: 'v1', changedFiles: [] })
    const changed = queue.complete(req.id, { status: 'completed', summary: 'v2', changedFiles: [] })
    expect(changed).toBe(false)
    expect(queue.getById(req.id)?.summary).toBe('v1')
  })
})

describe('queue — stale cleanup', () => {
  it('marks in-flight requests older than 5 min as failed', () => {
    vi.useFakeTimers()
    const element = { tag: 'div', id: '', classList: [], textContent: '', computedStyles: {} }
    queue.enqueue(element, 'test')
    // Manually claim (simulate dequeue side-effect)
    const req = queue.getAll()[0]!
    req.status = 'claimed'
    req.claimedAt = Date.now() - 6 * 60 * 1000  // 6 min ago
    queue._addToInFlight(req.id, req.claimedAt)

    vi.advanceTimersByTime(61_000)  // trigger cleanup interval

    expect(queue.getById(req.id)?.status).toBe('failed')
    expect(queue.getById(req.id)?.error).toBe('timed out')
  })
})

describe('queue — getById', () => {
  it('returns undefined for unknown id', () => {
    expect(queue.getById('nonexistent')).toBeUndefined()
  })
})
```

- [ ] **Step 1.2 — Run tests to confirm they fail**

```bash
npx vitest run tests/unit/queue.spec.ts
```

Expected: FAIL — `queue.ts` does not exist yet.

- [ ] **Step 1.3 — Implement `server/src/queue.ts`**

```typescript
/**
 * In-memory design request queue.
 * Singleton — shared across the server process.
 */

import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'

export interface ElementContext {
  tag: string
  id: string
  classList: string[]
  textContent: string
  computedStyles: Record<string, string>
  sourceFile?: string
  sourceLine?: number
}

export type RequestStatus = 'pending' | 'claimed' | 'completed' | 'failed'

export interface DesignRequest {
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

export interface CompletePayload {
  status: 'completed' | 'failed'
  summary?: string
  changedFiles?: string[]
  error?: string
}

const STALE_MS = 5 * 60 * 1000    // 5 minutes
const CLEANUP_INTERVAL_MS = 60_000 // 1 minute

class DesignQueue extends EventEmitter {
  private pending: string[] = []
  private requestsById = new Map<string, DesignRequest>()
  private inFlight = new Map<string, { claimedAt: number }>()
  private cleanupTimer: ReturnType<typeof setInterval>

  constructor() {
    super()
    this.cleanupTimer = setInterval(() => this.cleanupStale(), CLEANUP_INTERVAL_MS)
    // Don't keep the Node process alive just for cleanup
    if (this.cleanupTimer.unref) this.cleanupTimer.unref()
  }

  enqueue(element: ElementContext, userMessage: string): DesignRequest {
    const id = randomUUID()
    const request: DesignRequest = {
      id,
      element,
      userMessage,
      status: 'pending',
      createdAt: Date.now(),
    }
    this.requestsById.set(id, request)
    this.pending.push(id)
    this.emit('enqueue', request)
    return request
  }

  async dequeue(timeoutMs = 30_000): Promise<DesignRequest | null> {
    if (this.pending.length > 0) {
      return this.claim(this.pending.shift()!)
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.removeListener('enqueue', onEnqueue)
        resolve(null)
      }, timeoutMs)

      const onEnqueue = () => {
        clearTimeout(timer)
        if (this.pending.length > 0) {
          resolve(this.claim(this.pending.shift()!))
        } else {
          resolve(null)
        }
      }

      this.once('enqueue', onEnqueue)
    })
  }

  private claim(id: string): DesignRequest {
    const request = this.requestsById.get(id)!
    request.status = 'claimed'
    request.claimedAt = Date.now()
    this.inFlight.set(id, { claimedAt: request.claimedAt })
    return request
  }

  complete(id: string, payload: CompletePayload): boolean {
    const request = this.requestsById.get(id)
    if (!request) return false

    // Override rules (per spec)
    if (request.status === 'completed') return false
    if (request.status === 'failed' && payload.status === 'failed') return false

    request.status = payload.status
    request.completedAt = Date.now()
    if (payload.status === 'completed') {
      request.summary = payload.summary
      request.changedFiles = payload.changedFiles
    } else {
      request.error = payload.error
    }
    this.inFlight.delete(id)
    return true
  }

  getById(id: string): DesignRequest | undefined {
    return this.requestsById.get(id)
  }

  getAll(): DesignRequest[] {
    return Array.from(this.requestsById.values())
  }

  private cleanupStale(): void {
    const cutoff = Date.now() - STALE_MS
    for (const [id, { claimedAt }] of this.inFlight) {
      if (claimedAt < cutoff) {
        const request = this.requestsById.get(id)
        if (request) {
          request.status = 'failed'
          request.error = 'timed out'
        }
        this.inFlight.delete(id)
        this.emit('stale', id)
      }
    }
  }

  /** For test use only — resets all internal state */
  _resetForTest(): void {
    this.pending = []
    this.requestsById.clear()
    this.inFlight.clear()
    this.removeAllListeners('enqueue')
  }

  /** For test use only — inserts an id into inFlight directly */
  _addToInFlight(id: string, claimedAt: number): void {
    this.inFlight.set(id, { claimedAt })
  }
}

export const queue = new DesignQueue()
```

- [ ] **Step 1.4 — Run tests to confirm they pass**

```bash
npx vitest run tests/unit/queue.spec.ts
```

Expected: All tests PASS.

- [ ] **Step 1.5 — Commit**

```bash
git add server/src/queue.ts tests/unit/queue.spec.ts
git commit -m "feat: add in-memory design request queue with long-poll and stale cleanup"
```

---

## Task 2: app.ts — New HTTP Endpoints + WS Message Type

**Files:**
- Modify: `server/src/app.ts`
- Create: `tests/api/06-design-queue.spec.ts`

### Step 2.1 — Write failing integration tests

Create `tests/api/06-design-queue.spec.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import {
  startTestServer,
  teardownTestServer,
  wsConnect,
  waitForMessage,
  wsSend,
  type TestServer,
} from '../helpers/server-harness.js'
import { queue } from '../../server/src/queue.js'

let server: TestServer

beforeAll(async () => { server = await startTestServer() }, 10_000)
afterAll(async () => { await server?.close(); teardownTestServer() })
beforeEach(() => queue._resetForTest())

const ELEMENT = {
  tag: 'button',
  id: 'submit-btn',
  classList: ['btn', 'btn-primary'],
  textContent: 'Submit',
  computedStyles: { color: 'rgb(0,0,0)' },
}

describe('06 — Design Queue', () => {
  describe('WS: design:request → design:queued', () => {
    it('returns design:queued with a server-generated id', async () => {
      const ws = await wsConnect(server.wsUrl)
      const reply = waitForMessage(ws)
      wsSend(ws, { type: 'design:request', element: ELEMENT, userMessage: 'make it red' })
      const msg = await reply as Record<string, unknown>
      expect(msg.type).toBe('design:queued')
      expect(typeof msg.id).toBe('string')
      expect((msg.id as string).length).toBeGreaterThan(0)
      ws.close()
    })

    it('enqueues the request in the queue', async () => {
      const ws = await wsConnect(server.wsUrl)
      const reply = waitForMessage(ws)
      wsSend(ws, { type: 'design:request', element: ELEMENT, userMessage: 'resize it' })
      await reply
      expect(queue.getAll().length).toBe(1)
      expect(queue.getAll()[0]?.userMessage).toBe('resize it')
      ws.close()
    })
  })

  describe('GET /api/next', () => {
    it('returns { ok: true, request: null } when queue is empty (short timeout)', async () => {
      const res = await fetch(`${server.baseUrl}/api/next?timeout=50`)
      expect(res.status).toBe(200)
      const body = await res.json() as { ok: boolean; request: unknown }
      expect(body.ok).toBe(true)
      expect(body.request).toBeNull()
    })

    it('returns and claims the queued request', async () => {
      const ws = await wsConnect(server.wsUrl)
      wsSend(ws, { type: 'design:request', element: ELEMENT, userMessage: 'change font' })
      await waitForMessage(ws) // design:queued

      const res = await fetch(`${server.baseUrl}/api/next?timeout=1000`)
      const body = await res.json() as { ok: boolean; request: Record<string, unknown> }
      expect(body.ok).toBe(true)
      expect(body.request?.userMessage).toBe('change font')
      expect(body.request?.status).toBe('claimed')
      ws.close()
    })

    it('pushes design:processing to browser when request is claimed', async () => {
      const ws = await wsConnect(server.wsUrl)
      wsSend(ws, { type: 'design:request', element: ELEMENT, userMessage: 'fix padding' })
      await waitForMessage(ws) // design:queued

      const messages: Record<string, unknown>[] = []
      ws.on('message', (raw) => messages.push(JSON.parse(raw.toString())))

      await fetch(`${server.baseUrl}/api/next?timeout=1000`)

      // Allow time for WS push
      await new Promise((r) => setTimeout(r, 100))
      const processing = messages.find((m) => m['type'] === 'design:processing')
      expect(processing).toBeDefined()
      ws.close()
    })
  })

  describe('POST /api/complete/:id', () => {
    async function enqueueAndClaim(): Promise<string> {
      const ws = await wsConnect(server.wsUrl)
      wsSend(ws, { type: 'design:request', element: ELEMENT, userMessage: 'test' })
      const queued = await waitForMessage(ws) as Record<string, unknown>
      ws.close()
      await fetch(`${server.baseUrl}/api/next?timeout=1000`)
      return queued['id'] as string
    }

    it('marks request completed and returns { ok: true }', async () => {
      const id = await enqueueAndClaim()
      const res = await fetch(`${server.baseUrl}/api/complete/${id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'completed', summary: 'done', changedFiles: ['A.tsx'] }),
      })
      expect(res.status).toBe(200)
      const body = await res.json() as { ok: boolean }
      expect(body.ok).toBe(true)
      expect(queue.getById(id)?.status).toBe('completed')
    })

    it('returns 400 when status is failed but error is missing', async () => {
      const id = await enqueueAndClaim()
      const res = await fetch(`${server.baseUrl}/api/complete/${id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'failed' }),
      })
      expect(res.status).toBe(400)
    })

    it('returns 404 for unknown id', async () => {
      const res = await fetch(`${server.baseUrl}/api/complete/does-not-exist`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'failed', error: 'oops' }),
      })
      expect(res.status).toBe(404)
    })

    it('pushes design:done to browser on completion', async () => {
      const ws = await wsConnect(server.wsUrl)
      wsSend(ws, { type: 'design:request', element: ELEMENT, userMessage: 'test' })
      const queued = await waitForMessage(ws) as Record<string, unknown>
      const id = queued['id'] as string

      await fetch(`${server.baseUrl}/api/next?timeout=1000`)

      const messages: Record<string, unknown>[] = []
      ws.on('message', (raw) => messages.push(JSON.parse(raw.toString())))

      await fetch(`${server.baseUrl}/api/complete/${id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'completed', summary: 'Fixed', changedFiles: ['B.tsx'] }),
      })

      await new Promise((r) => setTimeout(r, 100))
      const done = messages.find((m) => m['type'] === 'design:done')
      expect(done?.['summary']).toBe('Fixed')
      expect(done?.['changedFiles']).toEqual(['B.tsx'])
      ws.close()
    })
  })

  describe('GET /api/requests/:id', () => {
    it('returns full request status by id', async () => {
      const ws = await wsConnect(server.wsUrl)
      wsSend(ws, { type: 'design:request', element: ELEMENT, userMessage: 'status test' })
      const queued = await waitForMessage(ws) as Record<string, unknown>
      const id = queued['id'] as string
      ws.close()

      const res = await fetch(`${server.baseUrl}/api/requests/${id}`)
      expect(res.status).toBe(200)
      const body = await res.json() as Record<string, unknown>
      expect(body['id']).toBe(id)
      expect(body['status']).toBe('pending')
      expect(body['createdAt']).toBeTypeOf('number')
    })

    it('returns 404 for unknown id', async () => {
      const res = await fetch(`${server.baseUrl}/api/requests/nonexistent`)
      expect(res.status).toBe(404)
    })
  })
})
```

- [ ] **Step 2.2 — Run tests to confirm they fail**

```bash
npx vitest run tests/api/06-design-queue.spec.ts
```

Expected: FAIL — endpoints and WS handler don't exist yet.

- [ ] **Step 2.3 — Add to `server/src/app.ts`**

Add these imports at the top of `app.ts`:

```typescript
import { queue, type ElementContext } from './queue.js'
```

First verify that `WebSocket` is imported in `app.ts` — it should already be there (`import { WebSocketServer, WebSocket } from 'ws'`). If not, add it.

Add the WS case inside the `switch (msg.type)` block (before the closing brace):

```typescript
case 'design:request': {
  const { element, userMessage } = msg as {
    type: 'design:request'
    element: ElementContext
    userMessage: string
  }
  if (!element || !userMessage) return
  const request = queue.enqueue(element, userMessage)
  send(ws, { type: 'design:queued', id: request.id })
  break
}
```

Add these HTTP routes after `app.get('/health', ...)`:

```typescript
// GET /api/next?timeout=<ms> — long-poll, atomic claim
app.get('/api/next', async (req, res) => {
  const timeoutMs = Math.min(parseInt(String(req.query['timeout'] ?? '30000'), 10), 60_000)
  const request = await queue.dequeue(timeoutMs)

  if (request) {
    // Push design:processing to all connected WS clients
    wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({ type: 'design:processing', id: request.id }))
      }
    })
  }

  res.json({ ok: true, request: request ?? null })
})

// POST /api/complete/:id — Claude Code writes back result
app.post('/api/complete/:id', (req, res) => {
  const { id } = req.params
  const { status, summary, changedFiles, error } = req.body as {
    status?: 'completed' | 'failed'
    summary?: string
    changedFiles?: string[]
    error?: string
  }

  if (status === 'failed' && !error) {
    res.status(400).json({ ok: false, error: 'error field is required when status is failed' })
    return
  }
  if (!status) {
    res.status(400).json({ ok: false, error: 'status is required' })
    return
  }

  const request = queue.getById(id!)
  if (!request) {
    res.status(404).json({ ok: false, error: 'request not found' })
    return
  }

  const changed = queue.complete(id!, { status, summary, changedFiles, error })

  if (changed) {
    const event = status === 'completed'
      ? { type: 'design:done', id, summary: summary ?? '', changedFiles: changedFiles ?? [] }
      : { type: 'design:failed', id, error: error ?? '' }

    wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify(event))
      }
    })
  }

  res.json({ ok: true })
})

// GET /api/requests/:id — status lookup for browser reconnection
app.get('/api/requests/:id', (req, res) => {
  const request = queue.getById(req.params['id']!)
  if (!request) {
    res.status(404).json({ ok: false, error: 'not found' })
    return
  }
  const { id, status, summary, changedFiles, error, createdAt, claimedAt, completedAt } = request
  res.json({ id, status, summary, changedFiles, error, createdAt, claimedAt, completedAt })
})
```

- [ ] **Step 2.4 — Run tests to confirm they pass**

```bash
npx vitest run tests/api/06-design-queue.spec.ts
```

Expected: All tests PASS.

- [ ] **Step 2.5 — Run full test suite to confirm no regressions**

```bash
npx vitest run
```

Expected: All existing tests continue to PASS.

- [ ] **Step 2.6 — Commit**

```bash
git add server/src/app.ts tests/api/06-design-queue.spec.ts
git commit -m "feat: add design:request WS handler and /api/next, /api/complete, /api/requests endpoints"
```

---

## Task 3: mcp.ts — MCP Stdio Server

**Files:**
- Modify: `server/package.json`
- Modify: `server/tsconfig.build.json`
- Create: `server/src/mcp.ts`

### Step 3.1 — Install MCP SDK

```bash
npm install @modelcontextprotocol/sdk --workspace=server
```

Expected: `@modelcontextprotocol/sdk` appears in `server/package.json` dependencies.

### Step 3.2 — Add `start:mcp` script and verify SDK install

Edit `server/package.json` — add to `"scripts"`:

```json
"start:mcp": "node dist/mcp.js"
```

### Step 3.3 — Update `server/tsconfig.build.json` to include `mcp.ts`

Current content:
```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "noEmit": false,
    "declaration": false
  }
}
```

Replace with:
```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "noEmit": false,
    "declaration": false
  },
  "include": ["src/**/*.ts"]
}
```

(The `include` is needed to ensure `mcp.ts` is included alongside `index.ts` as an additional entry point; both will be compiled to `dist/`.)

### Step 3.4 — Create `server/src/mcp.ts`

```typescript
/**
 * MCP stdio server — exposes design request tools to Claude Code.
 *
 * Tools:
 *   watch_design_requests  — long-poll GET /api/next, returns DesignRequest | null
 *   complete_design_request — POST /api/complete/:id
 *
 * All console output goes to stderr to avoid polluting the MCP stdio stream.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'

const SERVER_URL = 'http://127.0.0.1:3771'

const server = new Server(
  { name: 'design-easily', version: '0.1.0' },
  { capabilities: { tools: {} } },
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'watch_design_requests',
      description:
        'Long-poll for the next design request from the browser. ' +
        'Returns the request immediately if one is queued, or waits up to timeout_ms. ' +
        'Returns null on timeout (call again to keep listening). ' +
        'If the HTTP server is unreachable, returns an error message.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          timeout_ms: {
            type: 'number',
            description: 'Max wait time in milliseconds (default 30000, max 60000)',
          },
        },
      },
    },
    {
      name: 'complete_design_request',
      description:
        'Report the result of a design request back to the browser. ' +
        'Call this after editing source files. ' +
        'status must be "completed" or "failed". ' +
        'On completed: provide summary (what changed) and changedFiles (file paths). ' +
        'On failed: provide error (reason).',
      inputSchema: {
        type: 'object' as const,
        properties: {
          id: { type: 'string', description: 'Request ID returned by watch_design_requests' },
          status: { type: 'string', enum: ['completed', 'failed'] },
          summary: { type: 'string', description: 'Human-readable description of the change' },
          changedFiles: {
            type: 'array',
            items: { type: 'string' },
            description: 'Relative paths of files modified',
          },
          error: { type: 'string', description: 'Error message when status is failed' },
        },
        required: ['id', 'status'],
      },
    },
  ],
}))

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params

  if (name === 'watch_design_requests') {
    const timeoutMs = Math.min(
      typeof args?.['timeout_ms'] === 'number' ? args['timeout_ms'] : 30_000,
      60_000,
    )
    try {
      const res = await fetch(`${SERVER_URL}/api/next?timeout=${timeoutMs}`)
      if (!res.ok) throw new Error(`Server responded ${res.status}`)
      const body = await res.json() as { ok: boolean; request: unknown }
      return {
        content: [{ type: 'text', text: JSON.stringify(body.request, null, 2) }],
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return {
        content: [{
          type: 'text',
          text: `Error: cannot reach design-easily server. Please run: npm run dev:server\n(${msg})`,
        }],
        isError: true,
      }
    }
  }

  if (name === 'complete_design_request') {
    const { id, status, summary, changedFiles, error } = args as {
      id: string
      status: 'completed' | 'failed'
      summary?: string
      changedFiles?: string[]
      error?: string
    }
    try {
      const res = await fetch(`${SERVER_URL}/api/complete/${id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status, summary, changedFiles, error }),
      })
      const body = await res.json() as { ok: boolean; error?: string }
      if (!res.ok) {
        return {
          content: [{ type: 'text', text: `Server rejected completion: ${body.error ?? res.status}` }],
          isError: true,
        }
      }
      return { content: [{ type: 'text', text: JSON.stringify(body) }] }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return {
        content: [{
          type: 'text',
          text: `Error: cannot reach design-easily server.\n(${msg})`,
        }],
        isError: true,
      }
    }
  }

  return {
    content: [{ type: 'text', text: `Unknown tool: ${name}` }],
    isError: true,
  }
})

const transport = new StdioServerTransport()
await server.connect(transport)
// Log to stderr only — stdout is reserved for MCP protocol
process.stderr.write('design-easily MCP server started\n')
```

- [ ] **Step 3.5 — Build and smoke test manually**

```bash
# Build the server (compiles both index.ts and mcp.ts to dist/)
npm run build --workspace=server
```

Expected: `server/dist/mcp.js` is created with no TypeScript errors.

```bash
# Quick smoke test — list tools via stdin
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | node server/dist/mcp.js
```

Expected: JSON response on stdout listing `watch_design_requests` and `complete_design_request`.

- [ ] **Step 3.6 — Commit**

```bash
git add server/src/mcp.ts server/package.json server/tsconfig.build.json
git commit -m "feat: add MCP stdio server with watch_design_requests and complete_design_request tools"
```

---

## Task 4: Configuration Files

**Files:**
- Create: `.claude/settings.local.example.json`
- Modify: `.gitignore`

### Step 4.1 — Create `.gitignore` entry

Add to `.gitignore`:

```
# Local Claude Code MCP config (machine-specific — copy from settings.local.example.json)
.claude/settings.local.json
```

### Step 4.2 — Create example config

Create `.claude/settings.local.example.json`:

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

### Step 4.3 — Create your local config

```bash
cp .claude/settings.local.example.json .claude/settings.local.json
```

Then edit `.claude/settings.local.json` — replace `<absolute-path-to-project-root>` with the actual path:

```json
{
  "mcpServers": {
    "design-easily": {
      "command": "node",
      "args": ["server/dist/mcp.js"],
      "cwd": "/your/actual/path/to/design_easily"
    }
  }
}
```

### Step 4.4 — Verify `.gitignore` works

```bash
git status
```

Expected: `.claude/settings.local.json` does NOT appear as an untracked file. `.claude/settings.local.example.json` DOES appear.

- [ ] **Step 4.5 — Commit**

```bash
git add .gitignore .claude/settings.local.example.json
git commit -m "chore: add MCP config template and gitignore for local settings"
```

---

## Task 5: End-to-End Smoke Test

Manual verification after all tasks are complete.

- [ ] **Step 5.1 — Start the server**

```bash
npm run dev:server
```

Expected: Server starts on port 3771.

- [ ] **Step 5.2 — Restart Claude Code session**

Close and reopen Claude Code in this project directory. The MCP server should auto-spawn.

Verify in Claude Code:
```
/mcp
```

Expected: `design-easily` appears in the MCP server list with `watch_design_requests` and `complete_design_request` tools.

- [ ] **Step 5.3 — Trigger a design request via WebSocket**

Option A — use `websocat` (install with `brew install websocat`):

```bash
echo '{"type":"design:request","element":{"tag":"button","id":"","classList":[],"textContent":"Submit","computedStyles":{}},"userMessage":"make it red"}' \
  | websocat ws://127.0.0.1:3771
```

Expected: server responds with `{"type":"design:queued","id":"..."}`.

Option B — use the browser extension (load the unpacked extension, open any page, click an element, type a message, click "Send to Claude Code").

- [ ] **Step 5.4 — In Claude Code, call `watch_design_requests`**

Tell Claude Code:
> 开始监听设计请求

Claude Code should call `watch_design_requests(timeout_ms=30000)`. While it's waiting, send a design request from the browser (click an element → send message). Claude Code should receive the request, make changes, and call `complete_design_request`.

- [ ] **Step 5.5 — Run full test suite one final time**

```bash
npx vitest run
```

Expected: All tests PASS.

- [ ] **Step 5.6 — Final commit**

```bash
git add -A
git commit -m "chore: complete MCP integration — all tasks done"
```
