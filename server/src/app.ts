/**
 * App factory — creates and wires the Express app + WebSocket server.
 * Separated from index.ts so it can be imported in tests without side effects.
 */

import express from 'express'
import { WebSocketServer, WebSocket } from 'ws'
import { createServer, type Server } from 'node:http'
import { config } from './config.js'
import { openInVSCode } from './vscode.js'
import { readFileContext } from './fileReader.js'
import { streamAIResponse, type ChatMessage } from './ai.js'
import { streamOpenAIResponse } from './openai.js'
import { queue, type ElementContext } from './queue.js'

// ─── Message types ────────────────────────────────────────────────────────────

type ClientMessage =
  | { type: 'vscode:open'; file: string; line: number }
  | { type: 'ai:chat'; requestId: string; messages: ChatMessage[]; model?: string }
  | { type: 'design:request'; element: ElementContext; userMessage: string; action?: 'suggest' | 'develop' }
  | { type: 'ping' }

type ServerMessage =
  | { type: 'vscode:opened'; file: string; line: number }
  | { type: 'ai:chunk'; text: string; requestId: string }
  | { type: 'ai:done'; requestId: string }
  | { type: 'ai:error'; error: string; requestId: string }
  | { type: 'design:queued'; id: string }
  | { type: 'design:processing'; id: string }
  | { type: 'design:done'; id: string; action?: 'suggest' | 'develop'; content?: string; summary?: string; changedFiles?: string[] }
  | { type: 'design:failed'; id: string; error: string }
  | { type: 'pong' }

// ─── Factory ──────────────────────────────────────────────────────────────────

export interface AppInstance {
  httpServer: Server
}

export default function createApp(): AppInstance {
  const app = express()
  app.use(express.json())

  // CORS — local only
  app.use((_req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
    next()
  })

  app.get('/health', (_req, res) => {
    res.json({ ok: true, version: '0.1.0' })
  })

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
    const { status, summary, changedFiles, error, content } = req.body as {
      status?: 'completed' | 'failed'
      summary?: string
      changedFiles?: string[]
      error?: string
      content?: string
    }

    if (!status) {
      res.status(400).json({ ok: false, error: 'status is required' })
      return
    }
    if (status === 'failed' && !error) {
      res.status(400).json({ ok: false, error: 'error field is required when status is failed' })
      return
    }

    const existing = queue.getById(id!)
    if (!existing) {
      res.status(404).json({ ok: false, error: 'request not found' })
      return
    }

    const changed = queue.complete(id!, { status, summary, changedFiles, error, content })

    if (changed) {
      const event = status === 'completed'
        ? {
            type: 'design:done',
            id,
            action: existing.action,
            content: existing.content,
            summary: existing.summary ?? '',
            changedFiles: existing.changedFiles ?? [],
          }
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
    const { id, action, status, summary, changedFiles, content, error, createdAt, claimedAt, completedAt } = request
    res.json({ id, action, status, summary, changedFiles, content, error, createdAt, claimedAt, completedAt })
  })

  const httpServer = createServer(app)
  const wss = new WebSocketServer({ server: httpServer })

  function send(ws: WebSocket, msg: ServerMessage): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg))
    }
  }

  wss.on('connection', (ws) => {
    ws.on('message', async (raw) => {
      let msg: ClientMessage
      try {
        msg = JSON.parse(raw.toString()) as ClientMessage
      } catch {
        return // silently ignore malformed JSON
      }

      switch (msg.type) {
        case 'ping':
          send(ws, { type: 'pong' })
          break

        case 'vscode:open': {
          const { file, line } = msg
          if (!file) return // guard against empty path
          try {
            await openInVSCode(file, line)
            send(ws, { type: 'vscode:opened', file, line })
          } catch {
            // VS Code not found or failed to open — silently ignore
          }
          break
        }

        case 'design:request': {
          const { element, userMessage, action } = msg
          if (!element || !userMessage) return
          const request = queue.enqueue(element, userMessage, action)
          send(ws, { type: 'design:queued', id: request.id })
          break
        }

        case 'ai:chat': {
          const { requestId, messages, model } = msg
          if (!messages?.length) {
            send(ws, { type: 'ai:error', error: 'messages must not be empty', requestId })
            return
          }
          const enriched = await enrichWithFileContext(messages)
          const callbacks = {
            onChunk: (text: string) => send(ws, { type: 'ai:chunk', text, requestId }),
            onDone: () => send(ws, { type: 'ai:done', requestId }),
            onError: (err: Error) =>
              send(ws, { type: 'ai:error', error: err.message, requestId }),
          }

          if (config.aiProvider === 'openai') {
            const resolvedModel = model ?? config.openaiDefaultModel
            await streamOpenAIResponse(resolvedModel, enriched, callbacks)
          } else {
            const resolvedModel = model ?? config.defaultModel
            await streamAIResponse(resolvedModel, enriched, callbacks)
          }
          break
        }
      }
    })
  })

  return { httpServer }
}

async function enrichWithFileContext(messages: ChatMessage[]): Promise<ChatMessage[]> {
  const first = messages[0]
  if (!first || first.role !== 'user') return messages

  const fileMatch = first.content.match(/源文件：`([^`]+):(\d+)`/)
  if (!fileMatch) return messages

  const [, file, lineStr] = fileMatch
  const line = parseInt(lineStr ?? '1', 10)
  const ctx = await readFileContext(file, line)

  if (!ctx) return messages

  const enriched = `${first.content}\n\n源码片段（${ctx.file}，第 ${ctx.line} 行附近）：\n\`\`\`${ctx.language}\n${ctx.snippet}\n\`\`\``
  return [{ role: 'user', content: enriched }, ...messages.slice(1)]
}
