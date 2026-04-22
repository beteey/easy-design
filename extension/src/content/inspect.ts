/**
 * Inspect mode — hover highlight + click to select + right-side info panel.
 * Frosted glass Apple-style UI.
 */

import { extractFiberInfo, getComponentBreadcrumb, type FiberInfo } from './fiber'
import { wsClient } from './ws'

// ─── Highlight overlay ────────────────────────────────────────────────────────

const HIGHLIGHT_ID = 'de-highlight-overlay'

function getOrCreateHighlight(): HTMLElement {
  let el = document.getElementById(HIGHLIGHT_ID)
  if (!el) {
    el = document.createElement('div')
    el.id = HIGHLIGHT_ID
    Object.assign(el.style, {
      position: 'fixed',
      pointerEvents: 'none',
      zIndex: '2147483640',
      border: '2px solid #007AFF',
      borderRadius: '4px',
      background: 'rgba(0, 122, 255, 0.06)',
      transition: 'all 0.08s ease',
      display: 'none',
      boxSizing: 'border-box',
    })
    document.body.appendChild(el)
  }
  return el
}

function positionHighlight(el: HTMLElement, target: Element): void {
  const rect = target.getBoundingClientRect()
  Object.assign(el.style, {
    display: 'block',
    top: `${rect.top}px`,
    left: `${rect.left}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
  })
}

function hideHighlight(): void {
  const el = document.getElementById(HIGHLIGHT_ID)
  if (el) el.style.display = 'none'
}

// ─── Element context ──────────────────────────────────────────────────────────

export interface ElementContext {
  tag: string
  id: string
  classList: string[]
  textContent: string
  fiber: FiberInfo
  breadcrumb: string[]
  computedStyles: Record<string, string>
  rect: DOMRect
}

const RELEVANT_STYLES = [
  'display', 'flexDirection', 'alignItems', 'justifyContent',
  'padding', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
  'margin', 'marginTop', 'marginRight', 'marginBottom', 'marginLeft',
  'width', 'height', 'minWidth', 'maxWidth',
  'fontSize', 'fontWeight', 'fontFamily', 'lineHeight', 'color',
  'backgroundColor', 'borderRadius', 'border',
  'position', 'top', 'left', 'right', 'bottom',
  'opacity', 'boxShadow',
]

function buildContext(target: Element): ElementContext {
  const computed = window.getComputedStyle(target)
  const styles: Record<string, string> = {}
  for (const key of RELEVANT_STYLES) {
    const val = computed.getPropertyValue(key.replace(/([A-Z])/g, '-$1').toLowerCase())
    if (val && val !== 'initial' && val !== 'normal' && (val !== 'auto' || key.startsWith('margin'))) {
      styles[key] = val
    }
  }

  return {
    tag: target.tagName.toLowerCase(),
    id: target.id,
    classList: Array.from(target.classList),
    textContent: target.textContent?.trim().slice(0, 200) ?? '',
    fiber: extractFiberInfo(target),
    breadcrumb: getComponentBreadcrumb(target),
    computedStyles: styles,
    rect: target.getBoundingClientRect(),
  }
}

// ─── Info panel ───────────────────────────────────────────────────────────────

const PANEL_STYLES = `
  :host {
    all: initial;
    position: fixed;
    top: 64px;
    right: 16px;
    z-index: 2147483646;
    font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "Helvetica Neue", sans-serif;
    width: 320px;
    max-height: calc(100vh - 80px);
    display: flex;
    flex-direction: column;
  }
  .panel {
    background: rgba(255, 255, 255, 0.82);
    backdrop-filter: blur(24px) saturate(180%);
    -webkit-backdrop-filter: blur(24px) saturate(180%);
    border: 1px solid rgba(255, 255, 255, 0.6);
    border-radius: 16px;
    box-shadow: 0 8px 40px rgba(0,0,0,0.16), 0 1px 0 rgba(255,255,255,0.8) inset;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    max-height: calc(100vh - 80px);
  }
  .panel-header {
    padding: 14px 16px 10px;
    border-bottom: 1px solid rgba(0,0,0,0.07);
    flex-shrink: 0;
  }
  .component-name {
    font-size: 15px;
    font-weight: 600;
    color: #1c1c1e;
    margin: 0 0 4px;
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .component-badge {
    font-size: 10px;
    font-weight: 500;
    padding: 1px 6px;
    border-radius: 4px;
    background: rgba(0,122,255,0.1);
    color: #007AFF;
    letter-spacing: 0.2px;
  }
  .breadcrumb {
    font-size: 11px;
    color: rgba(0,0,0,0.4);
    margin: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .panel-body {
    overflow-y: auto;
    flex: 1;
    padding: 0 0 8px;
  }
  .section {
    padding: 10px 16px 4px;
  }
  .section-title {
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.6px;
    color: rgba(0,0,0,0.35);
    margin: 0 0 6px;
  }
  .row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 3px 0;
    font-size: 12px;
  }
  .row-key {
    color: rgba(0,0,0,0.45);
    flex-shrink: 0;
    width: 110px;
  }
  .row-val {
    color: #1c1c1e;
    text-align: right;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 160px;
    font-family: "SF Mono", "Menlo", monospace;
    font-size: 11px;
  }
  .source-row {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 8px 16px;
    cursor: pointer;
    border-top: 1px solid rgba(0,0,0,0.06);
    border-bottom: 1px solid rgba(0,0,0,0.06);
  }
  .source-row:hover {
    background: rgba(0,122,255,0.05);
  }
  .source-icon {
    font-size: 13px;
  }
  .source-info {
    flex: 1;
    overflow: hidden;
  }
  .source-file {
    font-size: 11px;
    font-family: "SF Mono", "Menlo", monospace;
    color: #007AFF;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .source-line {
    font-size: 10px;
    color: rgba(0,0,0,0.4);
  }
  .source-no-info {
    font-size: 11px;
    color: rgba(0,0,0,0.3);
    padding: 8px 16px;
  }
  .chat-area {
    border-top: 1px solid rgba(0,0,0,0.07);
    padding: 10px 12px;
    flex-shrink: 0;
  }
  .chat-messages {
    max-height: 200px;
    overflow-y: auto;
    margin-bottom: 8px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .msg {
    padding: 8px 10px;
    border-radius: 10px;
    font-size: 12px;
    line-height: 1.4;
    max-width: 90%;
  }
  .msg.user {
    background: #007AFF;
    color: white;
    align-self: flex-end;
    border-bottom-right-radius: 4px;
  }
  .msg.assistant {
    background: rgba(0,0,0,0.06);
    color: #1c1c1e;
    align-self: flex-start;
    border-bottom-left-radius: 4px;
    font-family: "SF Mono", "Menlo", monospace;
    font-size: 11px;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .msg.loading {
    background: rgba(0,0,0,0.04);
    color: rgba(0,0,0,0.35);
    align-self: flex-start;
    font-size: 11px;
    font-style: italic;
  }
  .chat-input-row {
    display: flex;
    gap: 6px;
    align-items: flex-end;
  }
  .chat-input {
    flex: 1;
    border: 1px solid rgba(0,0,0,0.12);
    border-radius: 10px;
    padding: 8px 10px;
    font-size: 12px;
    font-family: inherit;
    resize: none;
    outline: none;
    background: rgba(255,255,255,0.7);
    max-height: 80px;
    line-height: 1.4;
    color: #1c1c1e;
    transition: border-color 0.15s;
  }
  .chat-input:focus {
    border-color: #007AFF;
  }
  .chat-buttons {
    display: flex;
    flex-direction: column;
    gap: 4px;
    flex-shrink: 0;
  }
  .btn-suggest {
    padding: 5px 10px;
    border-radius: 8px;
    background: rgba(0,122,255,0.1);
    color: #007AFF;
    border: none;
    cursor: pointer;
    font-size: 11px;
    font-weight: 600;
    font-family: inherit;
    white-space: nowrap;
    transition: opacity 0.15s;
  }
  .btn-develop {
    padding: 5px 10px;
    border-radius: 8px;
    background: #007AFF;
    color: white;
    border: none;
    cursor: pointer;
    font-size: 11px;
    font-weight: 600;
    font-family: inherit;
    white-space: nowrap;
    transition: opacity 0.15s;
  }
  .btn-suggest:hover, .btn-develop:hover { opacity: 0.8; }
  .btn-suggest:disabled, .btn-develop:disabled { opacity: 0.3; cursor: not-allowed; }
`

export class InspectPanel {
  private host: HTMLElement
  private shadow: ShadowRoot
  private ctx: ElementContext | null = null
  private messages: Array<{ role: 'user' | 'assistant'; content: string }> = []
  private pendingRequestId: string | null = null
  private wsUnsubscribe: (() => void) | null = null

  constructor() {
    this.host = document.createElement('div')
    this.host.setAttribute('data-design-easily', 'panel')
    this.shadow = this.host.attachShadow({ mode: 'open' })
    this.shadow.innerHTML = `<style>${PANEL_STYLES}</style>`
    this.host.style.display = 'none'
    document.body.appendChild(this.host)

    this.wsUnsubscribe = wsClient.onMessage((msg) => {
      if (msg.type === 'design:queued') {
        this.pendingRequestId = msg.id
        this.updateLastAssistantMessage('⏳ 已发送，等待 Claude Code...')
      }
      if (msg.type === 'design:processing') {
        if (msg.id !== this.pendingRequestId) return
        this.updateLastAssistantMessage('⚙️ Claude Code 处理中...')
      }
      if (msg.type === 'design:done') {
        if (msg.id !== this.pendingRequestId) return
        const text = msg.action === 'suggest'
          ? (msg.content ?? '(未返回内容)')
          : `✅ 已修改：${(msg.changedFiles ?? []).join(', ') || (msg.summary ?? '完成')}`
        this.updateLastAssistantMessage(text)
        this.pendingRequestId = null
        this.setButtonsDisabled(false)
      }
      if (msg.type === 'design:failed') {
        if (msg.id !== this.pendingRequestId) return
        this.updateLastAssistantMessage(`❌ 失败：${msg.error}`)
        this.pendingRequestId = null
        this.setButtonsDisabled(false)
      }
    })
  }

  show(ctx: ElementContext): void {
    this.ctx = ctx
    this.host.style.display = ''
    this.renderPanel()
  }

  hide(): void {
    this.host.style.display = 'none'
    this.ctx = null
  }

  private renderPanel(): void {
    const ctx = this.ctx!
    const { fiber, tag, id, classList } = ctx

    const componentName = fiber.componentName ?? tag
    const sourceFile = fiber.sourceFile
    const sourceLine = fiber.sourceLine
    const shortFile = sourceFile ? sourceFile.split('/').slice(-2).join('/') : null

    const styleRows = Object.entries(ctx.computedStyles)
      .slice(0, 12)
      .map(([k, v]) => `
        <div class="row">
          <span class="row-key">${k}</span>
          <span class="row-val" title="${v}">${v}</span>
        </div>
      `).join('')

    const propRows = Object.entries(fiber.props)
      .slice(0, 8)
      .map(([k, v]) => `
        <div class="row">
          <span class="row-key">${k}</span>
          <span class="row-val" title="${String(v)}">${JSON.stringify(v).slice(0, 40)}</span>
        </div>
      `).join('')

    const sourceSection = shortFile
      ? `<div class="source-row" data-action="open-vscode">
          <span class="source-icon">⌨️</span>
          <div class="source-info">
            <div class="source-file" title="${sourceFile}">${shortFile}</div>
            <div class="source-line">第 ${sourceLine} 行 · 在 VS Code 中打开</div>
          </div>
          <span>›</span>
        </div>`
      : `<div class="source-no-info">未检测到源码信息（需 React 开发模式）</div>`

    const messagesHtml = this.messages.map((m) =>
      `<div class="msg ${m.role}">${this.escapeHtml(m.content)}</div>`
    ).join('')

    this.shadow.innerHTML = `
      <style>${PANEL_STYLES}</style>
      <div class="panel">
        <div class="panel-header">
          <p class="component-name">
            <span>${componentName}</span>
            ${fiber.componentName ? `<span class="component-badge">组件</span>` : ''}
          </p>
          <p class="breadcrumb">${ctx.breadcrumb.join(' › ') || `${tag}${id ? '#' + id : ''}${classList[0] ? '.' + classList[0] : ''}`}</p>
        </div>
        <div class="panel-body">
          ${sourceSection}
          <div class="section">
            <p class="section-title">元素信息</p>
            <div class="row"><span class="row-key">标签</span><span class="row-val">&lt;${tag}&gt;</span></div>
            ${id ? `<div class="row"><span class="row-key">ID</span><span class="row-val">#${id}</span></div>` : ''}
            ${classList.length ? `<div class="row"><span class="row-key">Class</span><span class="row-val">.${classList.slice(0, 3).join(' .')}</span></div>` : ''}
          </div>
          ${styleRows ? `<div class="section"><p class="section-title">计算样式</p>${styleRows}</div>` : ''}
          ${propRows ? `<div class="section"><p class="section-title">Props</p>${propRows}</div>` : ''}
        </div>
        <div class="chat-area">
          <div class="chat-messages">${messagesHtml}</div>
          <div class="chat-input-row">
            <textarea class="chat-input" placeholder="描述你想改什么..." rows="1"></textarea>
            <div class="chat-buttons">
              <button class="btn-suggest" data-action="suggest">💡 建议</button>
              <button class="btn-develop" data-action="develop">⚙️ 开发</button>
            </div>
          </div>
        </div>
      </div>
    `

    this.bindEvents()
    this.scrollChatToBottom()
  }

  private bindEvents(): void {
    const sourceRow = this.shadow.querySelector('[data-action="open-vscode"]')
    if (sourceRow && this.ctx?.fiber.sourceFile) {
      sourceRow.addEventListener('click', () => {
        wsClient.send({
          type: 'vscode:open',
          file: this.ctx!.fiber.sourceFile!,
          line: this.ctx!.fiber.sourceLine ?? 1,
        })
      })
    }

    const textarea = this.shadow.querySelector<HTMLTextAreaElement>('.chat-input')
    textarea?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        this.sendDesignRequest('develop')
      }
    })

    textarea?.addEventListener('input', () => {
      if (textarea) {
        textarea.style.height = 'auto'
        textarea.style.height = `${Math.min(textarea.scrollHeight, 80)}px`
      }
    })

    this.shadow.querySelector<HTMLButtonElement>('[data-action="suggest"]')
      ?.addEventListener('click', () => this.sendDesignRequest('suggest'))
    this.shadow.querySelector<HTMLButtonElement>('[data-action="develop"]')
      ?.addEventListener('click', () => this.sendDesignRequest('develop'))
  }

  private sendDesignRequest(action: 'suggest' | 'develop'): void {
    const textarea = this.shadow.querySelector<HTMLTextAreaElement>('.chat-input')
    const text = textarea?.value.trim()
    if (!text || this.pendingRequestId) return

    this.addMessage('user', text)
    if (textarea) textarea.value = ''

    this.addMessage('assistant', '⏳ 发送中...')
    this.setButtonsDisabled(true)

    const { tag, id, classList, computedStyles, textContent, fiber } = this.ctx!
    wsClient.send({
      type: 'design:request',
      action,
      userMessage: text,
      element: {
        tag,
        id,
        classList,
        textContent,
        computedStyles,
        sourceFile: fiber.sourceFile,
        sourceLine: fiber.sourceLine,
      },
    })
  }

  private addMessage(role: 'user' | 'assistant', content: string): void {
    this.messages.push({ role, content })
    this.renderPanel()
  }

  private updateLastAssistantMessage(content: string): void {
    const lastIdx = this.messages.length - 1
    if (lastIdx >= 0 && this.messages[lastIdx].role === 'assistant') {
      this.messages[lastIdx].content = content
      const msgs = this.shadow.querySelectorAll('.msg.assistant')
      const last = msgs[msgs.length - 1]
      if (last) last.textContent = content
      this.scrollChatToBottom()
    }
  }

  private scrollChatToBottom(): void {
    const chatMsgs = this.shadow.querySelector('.chat-messages')
    if (chatMsgs) chatMsgs.scrollTop = chatMsgs.scrollHeight
  }

  private setButtonsDisabled(disabled: boolean): void {
    const suggest = this.shadow.querySelector<HTMLButtonElement>('.btn-suggest')
    const develop = this.shadow.querySelector<HTMLButtonElement>('.btn-develop')
    if (suggest) suggest.disabled = disabled
    if (develop) develop.disabled = disabled
  }

  private escapeHtml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/\n/g, '<br>')
  }

  destroy(): void {
    this.wsUnsubscribe?.()
    this.host.remove()
  }
}

// ─── Inspect mode controller ──────────────────────────────────────────────────

export class InspectMode {
  private panel: InspectPanel
  private highlight: HTMLElement
  private selectedEl: Element | null = null
  private active = false

  constructor() {
    this.panel = new InspectPanel()
    this.highlight = getOrCreateHighlight()
  }

  enable(): void {
    this.active = true
    document.addEventListener('mouseover', this.onHover, true)
    document.addEventListener('click', this.onClick, true)
    document.body.style.cursor = 'crosshair'
  }

  disable(): void {
    this.active = false
    document.removeEventListener('mouseover', this.onHover, true)
    document.removeEventListener('click', this.onClick, true)
    document.body.style.cursor = ''
    hideHighlight()
    this.panel.hide()
    this.selectedEl = null
  }

  private onHover = (e: MouseEvent): void => {
    const target = e.target as Element
    if (!target || target.getAttribute('data-design-easily')) return

    positionHighlight(this.highlight, target)
  }

  private onClick = (e: MouseEvent): void => {
    const target = e.target as Element
    if (!target || target.getAttribute('data-design-easily')) return

    e.preventDefault()
    e.stopPropagation()

    this.selectedEl = target
    const ctx = buildContext(target)
    this.panel.show(ctx)
  }

  destroy(): void {
    this.disable()
    this.panel.destroy()
    this.highlight.remove()
  }
}
