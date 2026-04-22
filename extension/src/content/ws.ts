/**
 * WebSocket client — connects content script to the local design-easily server.
 * Auto-reconnects with exponential backoff.
 */

const SERVER_PORT = 3771
const WS_URL = `ws://127.0.0.1:${SERVER_PORT}`

type MessageHandler = (data: ServerMessage) => void

export type ServerMessage =
  | { type: 'vscode:opened'; file: string; line: number }
  | { type: 'ai:chunk'; text: string; requestId: string }
  | { type: 'ai:done'; requestId: string }
  | { type: 'ai:error'; error: string; requestId: string }
  | { type: 'design:queued'; id: string }
  | { type: 'design:processing'; id: string }
  | { type: 'design:done'; id: string; action?: 'suggest' | 'develop'; content?: string; summary?: string; changedFiles?: string[] }
  | { type: 'design:failed'; id: string; error: string }
  | { type: 'pong' }

export type ClientMessage =
  | { type: 'vscode:open'; file: string; line: number }
  | { type: 'ai:chat'; requestId: string; messages: ChatMessage[]; model?: string }
  | { type: 'design:request'; element: Record<string, unknown>; userMessage: string; action?: 'suggest' | 'develop' }
  | { type: 'ping' }

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

class WSClient {
  private ws: WebSocket | null = null
  private handlers = new Set<MessageHandler>()
  private reconnectDelay = 1000
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private connected = false

  connect(): void {
    if (this.ws?.readyState === WebSocket.CONNECTING) return

    try {
      this.ws = new WebSocket(WS_URL)

      this.ws.onopen = () => {
        this.connected = true
        this.reconnectDelay = 1000
        this.send({ type: 'ping' })
      }

      this.ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data) as ServerMessage
          this.handlers.forEach((h) => h(data))
        } catch {
          // ignore malformed messages
        }
      }

      this.ws.onclose = () => {
        this.connected = false
        this.scheduleReconnect()
      }

      this.ws.onerror = () => {
        this.ws?.close()
      }
    } catch {
      this.scheduleReconnect()
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.reconnectDelay = Math.min(this.reconnectDelay * 1.5, 10000)
      this.connect()
    }, this.reconnectDelay)
  }

  send(msg: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg))
    }
  }

  onMessage(handler: MessageHandler): () => void {
    this.handlers.add(handler)
    return () => this.handlers.delete(handler)
  }

  isConnected(): boolean {
    return this.connected
  }
}

export const wsClient = new WSClient()
