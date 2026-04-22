# [建议][开发] 双按钮 & 统一 MCP 流 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 inspect 面板的单发送按钮改为 [建议][开发] 两个按钮，所有请求统一通过 Claude Code MCP 队列处理，移除直接 Anthropic API 流。

**Architecture:** 新增 `action: 'suggest' | 'develop'` 字段贯穿 queue → server → extension，`complete_design_request` MCP 工具新增 `content` 字段供建议模式返回文字。Extension 监听 `design:queued/processing/done/failed` WS 消息展示状态。

**Tech Stack:** TypeScript, Node.js (Express + ws), Chrome Extension (Shadow DOM), Vitest, MCP SDK

---

## 文件结构

| 文件 | 改动类型 | 说明 |
|------|---------|------|
| `server/src/queue.ts` | Modify | 新增 `action`、`content` 字段；`enqueue()` 接收 action |
| `server/src/app.ts` | Modify | 透传 action；complete 端点支持 content；requests 端点返回 action/content；补全 ServerMessage 类型 |
| `server/src/mcp.ts` | Modify | inputSchema 新增 content；handler 透传 content |
| `extension/src/content/ws.ts` | Modify | 补全 ClientMessage（design:request）和 ServerMessage（design 系列事件）类型 |
| `extension/src/content/inspect.ts` | Modify | 移除 ai:chat；改为 sendDesignRequest()；双按钮 UI；监听 design 事件 |
| `tests/unit/queue.spec.ts` | Modify | 新增 action/content 字段测试 |
| `tests/api/06-design-queue.spec.ts` | Modify | 新增 action 透传、content 返回、/api/requests/:id 字段测试 |

---

## Task 1: 扩展 queue.ts — action 和 content 字段

**Files:**
- Modify: `server/src/queue.ts:9-40`
- Test: `tests/unit/queue.spec.ts`

- [ ] **Step 1: 写失败测试 — action 字段**

在 `tests/unit/queue.spec.ts` 的 `describe('queue — enqueue'` 块末尾追加：

```typescript
it('stores action field, defaults to develop', () => {
  const element = { tag: 'div', id: '', classList: [], textContent: '', computedStyles: {} }
  const req1 = queue.enqueue(element, 'test')
  expect(req1.action).toBe('develop')

  const req2 = queue.enqueue(element, 'test', 'suggest')
  expect(req2.action).toBe('suggest')
})
```

- [ ] **Step 2: 运行测试确认失败**

```bash
npx vitest run tests/unit/queue.spec.ts 2>&1 | tail -20
```

Expected: FAIL — `req1.action` is undefined

- [ ] **Step 3: 写失败测试 — content 字段**

在 `tests/unit/queue.spec.ts` 的 `describe('queue — complete'` 块末尾追加：

```typescript
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
```

- [ ] **Step 4: 运行测试确认失败**

```bash
npx vitest run tests/unit/queue.spec.ts 2>&1 | tail -20
```

Expected: FAIL — `content` is undefined

- [ ] **Step 5: 实现 queue.ts 改动**

修改 `server/src/queue.ts`：

```typescript
// DesignRequest 接口新增两个字段（加在 error?: string 后面）：
export interface DesignRequest {
  id: string
  element: ElementContext
  userMessage: string
  action: 'suggest' | 'develop'   // ← 新增
  status: RequestStatus
  createdAt: number
  claimedAt?: number
  completedAt?: number
  changedFiles?: string[]
  summary?: string
  content?: string                  // ← 新增
  error?: string
}

// CompletePayload 新增 content 字段：
export interface CompletePayload {
  status: 'completed' | 'failed'
  summary?: string
  changedFiles?: string[]
  content?: string                  // ← 新增
  error?: string
}
```

修改 `enqueue()` 方法签名和实现：

```typescript
enqueue(element: ElementContext, userMessage: string, action: 'suggest' | 'develop' = 'develop'): DesignRequest {
  const id = randomUUID()
  const request: DesignRequest = {
    id,
    element,
    userMessage,
    action,                         // ← 新增
    status: 'pending',
    createdAt: Date.now(),
  }
  this.requestsById.set(id, request)
  this.pending.push(id)
  this.emit('enqueue', request)
  return request
}
```

修改 `complete()` 的 completed 分支，在 `request.changedFiles = payload.changedFiles` 后追加：

```typescript
request.content = payload.content  // ← 新增
```

- [ ] **Step 6: 运行测试确认通过**

```bash
npx vitest run tests/unit/queue.spec.ts 2>&1 | tail -20
```

Expected: 所有测试 PASS

- [ ] **Step 7: Commit**

```bash
git add server/src/queue.ts tests/unit/queue.spec.ts
git commit -m "feat: add action and content fields to queue"
```

---

## Task 2: 扩展 app.ts — 透传 action，complete/requests 端点更新

**Files:**
- Modify: `server/src/app.ts:18-122`
- Test: `tests/api/06-design-queue.spec.ts`

- [ ] **Step 1: 写失败测试 — action 透传到 GET /api/next**

在 `tests/api/06-design-queue.spec.ts` 的 `describe('GET /api/next'` 块末尾追加：

```typescript
it('preserves action field in dequeued request', async () => {
  const ws = await wsConnect(server.wsUrl)
  wsSend(ws, { type: 'design:request', element: ELEMENT, userMessage: 'test', action: 'suggest' })
  await waitForMessage(ws) // design:queued

  const res = await fetch(`${server.baseUrl}/api/next?timeout=1000`)
  const body = await res.json() as { ok: boolean; request: Record<string, unknown> }
  expect(body.request?.action).toBe('suggest')
  ws.close()
})
```

- [ ] **Step 2: 运行测试确认失败**

```bash
npx vitest run tests/api/06-design-queue.spec.ts 2>&1 | tail -20
```

Expected: FAIL — `action` is undefined on dequeued request

- [ ] **Step 3: 写失败测试 — design:done 含 action 和 content**

在 `describe('POST /api/complete/:id'` 块末尾追加：

```typescript
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
```

- [ ] **Step 4: 写失败测试 — GET /api/requests/:id 返回 action 和 content**

在 `describe('GET /api/requests/:id'` 块末尾追加：

```typescript
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
```

- [ ] **Step 5: 运行测试确认失败**

```bash
npx vitest run tests/api/06-design-queue.spec.ts 2>&1 | tail -20
```

Expected: 3 new tests FAIL

- [ ] **Step 6: 实现 app.ts 改动**

**6a. 更新 ClientMessage 类型**（在 `type ClientMessage =` 块中）：

```typescript
| { type: 'design:request'; element: ElementContext; userMessage: string; action?: 'suggest' | 'develop' }
```

**6b. 更新 ServerMessage 类型**（替换现有的 design 相关类型，在 `type ServerMessage =` 块中追加）：

```typescript
| { type: 'design:processing'; id: string }
| { type: 'design:done'; id: string; action?: 'suggest' | 'develop'; content?: string; summary?: string; changedFiles?: string[] }
| { type: 'design:failed'; id: string; error: string }
```

**6c. 更新 `design:request` handler**（在 `case 'design:request':` 块中）：

```typescript
case 'design:request': {
  const { element, userMessage, action } = msg
  if (!element || !userMessage) return
  const request = queue.enqueue(element, userMessage, action)
  send(ws, { type: 'design:queued', id: request.id })
  break
}
```

**6d. 更新 `POST /api/complete/:id`**（在该路由 handler 中）：

```typescript
app.post('/api/complete/:id', (req, res) => {
  const { id } = req.params
  const { status, summary, changedFiles, error, content } = req.body as {   // ← 新增 content
    status?: 'completed' | 'failed'
    summary?: string
    changedFiles?: string[]
    error?: string
    content?: string                                                           // ← 新增
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

  const changed = queue.complete(id!, { status, summary, changedFiles, error, content })  // ← 传 content

  if (changed) {
    const event = status === 'completed'
      ? {
          type: 'design:done',
          id,
          action: existing.action,                    // ← 新增：从已有引用读取
          content: existing.content,                  // ← 新增
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
```

**6e. 更新 `GET /api/requests/:id`**：

```typescript
app.get('/api/requests/:id', (req, res) => {
  const request = queue.getById(req.params['id']!)
  if (!request) {
    res.status(404).json({ ok: false, error: 'not found' })
    return
  }
  const { id, action, status, summary, changedFiles, content, error, createdAt, claimedAt, completedAt } = request
  res.json({ id, action, status, summary, changedFiles, content, error, createdAt, claimedAt, completedAt })
})
```

- [ ] **Step 7: 运行测试确认全部通过**

```bash
npx vitest run tests/api/06-design-queue.spec.ts 2>&1 | tail -30
```

Expected: 所有测试 PASS（包含新增的 3 个）

- [ ] **Step 8: 运行全量测试确认无回归**

```bash
npx vitest run 2>&1 | tail -20
```

Expected: 所有测试 PASS

- [ ] **Step 9: Commit**

```bash
git add server/src/app.ts tests/api/06-design-queue.spec.ts
git commit -m "feat: propagate action/content through server endpoints"
```

---

## Task 3: 扩展 mcp.ts — complete_design_request 支持 content

**Files:**
- Modify: `server/src/mcp.ts:45-130`

（MCP server 是 stdio 进程，无自动化测试；通过 TypeScript 编译验证正确性）

- [ ] **Step 1: 更新 inputSchema**

在 `complete_design_request` 工具的 `inputSchema.properties` 中追加：

```typescript
content: {
  type: 'string',
  description: 'Text content for suggest mode (returned as advice text to the user)',
},
```

更新工具 `description`：

```typescript
description:
  'Report the result of a design request back to the browser. ' +
  'Call this after handling the request. ' +
  'status must be "completed" or "failed". ' +
  'For suggest mode: provide content (advice text). ' +
  'For develop mode: provide summary (what changed) and changedFiles (file paths). ' +
  'On failed: provide error (reason).',
```

- [ ] **Step 2: 更新 handler 解构和 POST body**

在 `if (name === 'complete_design_request')` 块中，将解构改为：

```typescript
const { id, status, summary, changedFiles, error, content } = args as {
  id: string
  status: 'completed' | 'failed'
  summary?: string
  changedFiles?: string[]
  error?: string
  content?: string              // ← 新增
}
```

将 `JSON.stringify` 改为：

```typescript
body: JSON.stringify({ status, summary, changedFiles, error, content }),  // ← 新增 content
```

- [ ] **Step 3: 编译验证**

```bash
cd server && npx tsc --noEmit 2>&1
```

Expected: 无错误

- [ ] **Step 4: Commit**

```bash
git add server/src/mcp.ts
git commit -m "feat: add content field to complete_design_request MCP tool"
```

---

## Task 4: 更新 ws.ts — 补全类型定义

**Files:**
- Modify: `extension/src/content/ws.ts:11-27`

（类型定义文件，通过 TypeScript 编译验证）

- [ ] **Step 1: 更新 ServerMessage 类型**

将现有 `ServerMessage` 替换为：

```typescript
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
```

- [ ] **Step 2: 更新 ClientMessage 类型**

在 `ClientMessage` 中，将 `ai:chat` 行后追加：

```typescript
| { type: 'design:request'; element: Record<string, unknown>; userMessage: string; action?: 'suggest' | 'develop' }
```

（注：extension 中 ElementContext 与 server 中略有不同，使用 `Record<string, unknown>` 作为宽松类型；若项目已导出共享类型则使用对应类型）

- [ ] **Step 3: 编译验证**

```bash
cd extension && npx tsc --noEmit 2>&1
```

Expected: 无错误

- [ ] **Step 4: Commit**

```bash
git add extension/src/content/ws.ts
git commit -m "feat: add design:request and design event types to ws client"
```

---

## Task 5: 改造 inspect.ts — 双按钮 UI 和 MCP 流

**Files:**
- Modify: `extension/src/content/inspect.ts:229-546`

- [ ] **Step 1: 更新 CSS — 移除 `.chat-send`，新增双按钮样式**

在 `PANEL_STYLES` 中，找到 `.chat-send` 规则块，将其替换为：

```css
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
```

- [ ] **Step 2: 更新 chat-area HTML 模板**

在 `renderPanel()` 方法的 `chat-area` 部分，将：

```html
<div class="chat-input-row">
  <textarea class="chat-input" placeholder="描述你想改什么..." rows="1"></textarea>
  <button class="chat-send" data-action="send">↑</button>
</div>
```

替换为：

```html
<div class="chat-input-row">
  <textarea class="chat-input" placeholder="描述你想改什么..." rows="1"></textarea>
  <div class="chat-buttons">
    <button class="btn-suggest" data-action="suggest">💡 建议</button>
    <button class="btn-develop" data-action="develop">⚙️ 开发</button>
  </div>
</div>
```

- [ ] **Step 3: 更新类成员变量**

在 `InspectPanel` 类中，将：

```typescript
private currentRequestId: string | null = null
```

替换为：

```typescript
private pendingRequestId: string | null = null
```

- [ ] **Step 4: 更新 WS 监听器**

在 `constructor()` 的 `wsUnsubscribe` 赋值中，移除对 `ai:chunk`、`ai:done`、`ai:error` 的处理，替换为：

```typescript
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
      : `✅ 已修改：${(msg.changedFiles ?? []).join(', ') || msg.summary ?? '完成'}`
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
```

- [ ] **Step 5: 更新 bindEvents()**

将 `sendBtn?.addEventListener('click', () => this.sendMessage())` 替换为：

```typescript
this.shadow.querySelector<HTMLButtonElement>('[data-action="suggest"]')
  ?.addEventListener('click', () => this.sendDesignRequest('suggest'))
this.shadow.querySelector<HTMLButtonElement>('[data-action="develop"]')
  ?.addEventListener('click', () => this.sendDesignRequest('develop'))
```

删除 `textarea?.addEventListener('keydown', ...)` 中调用 `this.sendMessage()` 的行，改为调用 `this.sendDesignRequest('develop')`（Enter 默认走开发模式）：

```typescript
textarea?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    this.sendDesignRequest('develop')
  }
})
```

- [ ] **Step 6: 新增 sendDesignRequest() 方法，移除 sendMessage()**

移除整个 `sendMessage()` 方法和 `buildSystemContext()` 方法。

新增：

```typescript
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
```

- [ ] **Step 7: 更新 setButtonsDisabled() 辅助方法**

将 `setSendDisabled()` 重命名为 `setButtonsDisabled()`，实现：

```typescript
private setButtonsDisabled(disabled: boolean): void {
  const suggest = this.shadow.querySelector<HTMLButtonElement>('.btn-suggest')
  const develop = this.shadow.querySelector<HTMLButtonElement>('.btn-develop')
  if (suggest) suggest.disabled = disabled
  if (develop) develop.disabled = disabled
}
```

删除旧的 `setSendDisabled()` 方法。

- [ ] **Step 8: 编译验证**

```bash
cd extension && npx tsc --noEmit 2>&1
```

Expected: 无错误

- [ ] **Step 9: 运行全量测试确认无回归**

```bash
npx vitest run 2>&1 | tail -20
```

Expected: 所有测试 PASS

- [ ] **Step 10: Commit**

```bash
git add extension/src/content/inspect.ts extension/src/content/ws.ts
git commit -m "feat: replace ai:chat with suggest/develop dual buttons in inspect panel"
```

---

## Task 6: 最终验证

- [ ] **Step 1: 运行全量测试**

```bash
npx vitest run 2>&1 | tail -30
```

Expected: 所有测试 PASS，无 FAIL

- [ ] **Step 2: TypeScript 编译 server**

```bash
cd server && npx tsc --noEmit 2>&1
```

Expected: 无错误

- [ ] **Step 3: TypeScript 编译 extension**

```bash
cd extension && npx tsc --noEmit 2>&1
```

Expected: 无错误

- [ ] **Step 4: 最终 commit（若有遗漏文件）**

```bash
git status
# 若有未提交文件：
git add <files>
git commit -m "chore: final cleanup"
```
