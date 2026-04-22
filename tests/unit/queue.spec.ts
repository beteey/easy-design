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

  it('stores action field, defaults to develop', () => {
    const element = { tag: 'div', id: '', classList: [], textContent: '', computedStyles: {} }
    const req1 = queue.enqueue(element, 'test')
    expect(req1.action).toBe('develop')

    const req2 = queue.enqueue(element, 'test', 'suggest')
    expect(req2.action).toBe('suggest')
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

  it('stores content for suggest mode completion', async () => {
    const element = { tag: 'div', id: '', classList: [], textContent: '', computedStyles: {} }
    queue.enqueue(element, 'test', 'suggest')
    await queue.dequeue(1000)
    const req = queue.getAll()[0]!
    queue.complete(req.id, {
      status: 'completed',
      content: 'Add border-radius: 8px to the button',
    })
    expect(queue.getById(req.id)?.content).toBe('Add border-radius: 8px to the button')
    expect(queue.getById(req.id)?.status).toBe('completed')
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
    const element = { tag: 'div', id: '', classList: [], textContent: '', computedStyles: {} }
    queue.enqueue(element, 'test')
    // Manually claim and backdate claimedAt to simulate a 6-min-old in-flight entry
    const req = queue.getAll()[0]!
    req.status = 'claimed'
    req.claimedAt = Date.now() - 6 * 60 * 1000  // 6 min ago
    queue._addToInFlight(req.id, req.claimedAt)

    queue._runCleanupForTest()

    expect(queue.getById(req.id)?.status).toBe('failed')
    expect(queue.getById(req.id)?.error).toBe('timed out')
  })
})

describe('queue — getById', () => {
  it('returns undefined for unknown id', () => {
    expect(queue.getById('nonexistent')).toBeUndefined()
  })
})
