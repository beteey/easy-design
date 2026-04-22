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
  action: 'suggest' | 'develop'
  status: RequestStatus
  createdAt: number
  claimedAt?: number
  completedAt?: number
  changedFiles?: string[]
  summary?: string
  content?: string
  error?: string
}

export interface CompletePayload {
  status: 'completed' | 'failed'
  summary?: string
  changedFiles?: string[]
  content?: string
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

  enqueue(element: ElementContext, userMessage: string, action: 'suggest' | 'develop' = 'develop'): DesignRequest {
    const id = randomUUID()
    const request: DesignRequest = {
      id,
      element,
      userMessage,
      action,
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
      request.content = payload.content
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

  /** For test use only — runs stale cleanup synchronously */
  _runCleanupForTest(): void {
    this.cleanupStale()
  }
}

export const queue = new DesignQueue()
