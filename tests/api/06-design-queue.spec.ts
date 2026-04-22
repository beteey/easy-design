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

    it('preserves action field in dequeued request', async () => {
      const ws = await wsConnect(server.wsUrl)
      wsSend(ws, { type: 'design:request', element: ELEMENT, userMessage: 'test', action: 'suggest' })
      await waitForMessage(ws) // design:queued

      const res = await fetch(`${server.baseUrl}/api/next?timeout=1000`)
      const body = await res.json() as { ok: boolean; request: Record<string, unknown> }
      expect(body.request?.action).toBe('suggest')
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

    it('pushes design:done with action and content for suggest mode', async () => {
      const ws = await wsConnect(server.wsUrl)
      wsSend(ws, { type: 'design:request', element: ELEMENT, userMessage: 'test', action: 'suggest' })
      const queued = await waitForMessage(ws) as Record<string, unknown>
      const id = queued['id'] as string

      await fetch(`${server.baseUrl}/api/next?timeout=1000`)

      const messages: Record<string, unknown>[] = []
      ws.on('message', (raw) => messages.push(JSON.parse(raw.toString())))

      await fetch(`${server.baseUrl}/api/complete/${id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'completed', content: 'Use border-radius: 8px' }),
      })

      await new Promise((r) => setTimeout(r, 100))
      const done = messages.find((m) => m['type'] === 'design:done')
      expect(done?.['action']).toBe('suggest')
      expect(done?.['content']).toBe('Use border-radius: 8px')
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

    it('returns action and content after suggest-mode completion', async () => {
      const ws = await wsConnect(server.wsUrl)
      wsSend(ws, { type: 'design:request', element: ELEMENT, userMessage: 'test', action: 'suggest' })
      const queued = await waitForMessage(ws) as Record<string, unknown>
      const id = queued['id'] as string
      ws.close()

      await fetch(`${server.baseUrl}/api/next?timeout=1000`)
      await fetch(`${server.baseUrl}/api/complete/${id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'completed', content: 'Add padding: 16px' }),
      })

      const res = await fetch(`${server.baseUrl}/api/requests/${id}`)
      const body = await res.json() as Record<string, unknown>
      expect(body['action']).toBe('suggest')
      expect(body['content']).toBe('Add padding: 16px')
    })
  })
})
