# [建议][开发] 双按钮 & 统一 MCP 流 设计文档

## 目标

将 inspect 面板的单个发送按钮改为 [建议][开发] 两个按钮，移除直接 Anthropic API 流，所有请求统一通过 Claude Code MCP 处理。

## 背景

现有系统有两条并行路径：
1. `ai:chat` — 直接调用 Anthropic SDK 流式返回，在 inspect 面板聊天区展示
2. `design:request` → MCP queue → Claude Code 处理 → `complete_design_request`

新设计废弃路径 1，统一走路径 2，通过 `action` 字段区分「建议」和「开发」两种模式。

---

## 架构

### 消息流

**建议模式（suggest）：**
```
用户点 [建议]
  → WS: design:request { action: 'suggest', element, userMessage }
  → Server: 入队（action 存入 DesignRequest），返回 design:queued { id }
  → Extension: 记录 pendingRequestId = id
  → Claude Code: watch_design_requests 拿到请求（含 action 字段）
  → Claude Code: 分析元素，生成文字建议
  → Claude Code: complete_design_request { id, status: 'completed', content: '...' }
  → Server: queue.complete() 存储 content；从 queue.getById(id) 读 action
  → Server: WS 广播 design:done { id, action: 'suggest', content: '...' }
  → Extension: pendingRequestId 匹配 → 聊天区显示建议文字；忽略不匹配的 id
```

**开发模式（develop）：**
```
用户点 [开发]
  → WS: design:request { action: 'develop', element, userMessage }
  → Server: 入队，返回 design:queued { id }
  → Extension: 记录 pendingRequestId = id
  → Claude Code: watch_design_requests 拿到请求
  → Claude Code: 直接修改源文件
  → Claude Code: complete_design_request { id, status: 'completed', summary: '...', changedFiles: [...] }
  → Server: queue.complete() 存储 summary/changedFiles；读 action
  → Server: WS 广播 design:done { id, action: 'develop', summary: '...', changedFiles: [...] }
  → Extension: pendingRequestId 匹配 → 显示「✅ 已修改：file1.tsx」；忽略不匹配的 id
```

---

## 变更清单

### 1. `server/src/queue.ts`

- `DesignRequest` 新增字段：`action?: 'suggest' | 'develop'`；`content?: string`
- `CompletePayload` 新增字段：`content?: string`
- `enqueue(element, userMessage, action?)` 参数新增 `action`，默认值 `'develop'`，存入 request
- `complete()` 的 `status === 'completed'` 分支新增：`request.content = payload.content`

### 2. `server/src/app.ts`

- `ClientMessage` 中 `design:request` 新增 `action?: 'suggest' | 'develop'`
- `design:request` handler：读取 `msg.action`，透传给 `queue.enqueue(element, userMessage, action)`
- `ServerMessage` 补充完整类型：
  - `design:queued { id }`
  - `design:processing { id }`
  - `design:done { id; action?: string; content?: string; summary?: string; changedFiles?: string[] }`
  - `design:failed { id; error: string }`
- `POST /api/complete/:id`：
  - 接收 body 中的 `content` 字段
  - 调用 `queue.complete(id, { status, summary, changedFiles, error, content })`
  - 构建 WS 事件时，使用已取得的 `existing` 引用（`queue.getById(id)` 的预取结果）读取 `existing.action`，并在 `design:done` 中包含 `action` 和 `content`（注：`existing` 是同一对象引用，`complete()` 修改后仍可直接读取其 `action`）
- `GET /api/requests/:id`：响应新增 `action` 和 `content` 字段（支持断线重连恢复）

### 3. `server/src/mcp.ts`

- `complete_design_request` inputSchema 新增 `content` 属性（type: string，描述：建议模式返回的文字内容）
- handler 的 `args` 解构新增 `content`，并在 POST body 的 `JSON.stringify` 中包含 `content`
- 工具描述更新：建议模式用 `content` 字段，开发模式用 `summary` + `changedFiles`

### 4. `extension/src/content/ws.ts`

- `ClientMessage` 新增 `design:request` 类型（目前完全缺失）：
  ```ts
  { type: 'design:request'; element: ElementContext; userMessage: string; action?: 'suggest' | 'develop' }
  ```
- `ServerMessage` 新增：
  - `{ type: 'design:queued'; id: string }`
  - `{ type: 'design:processing'; id: string }`
  - `{ type: 'design:done'; id: string; action?: 'suggest' | 'develop'; content?: string; summary?: string; changedFiles?: string[] }`
  - `{ type: 'design:failed'; id: string; error: string }`
- 保留 `ai:chunk`、`ai:done`、`ai:error` 类型定义（服务端代码未删），但 inspect.ts 不再使用

### 5. `extension/src/content/inspect.ts`

- 移除 `sendMessage()` 中的 `ai:chat` 调用
- 移除对 `ai:chunk`、`ai:done`、`ai:error` 的监听
- 新增 `pendingRequestId: string | null` 状态（替代 `currentRequestId`）
- 新增 `sendDesignRequest(action: 'suggest' | 'develop')` 方法：
  - 读取用户输入，若空或已有 pending 则返回
  - 添加用户消息到聊天
  - 发送 `design:request { action, element, userMessage }`
  - 禁用两个按钮
- WS 监听器处理（匹配 `pendingRequestId`，不匹配则忽略）：
  - `design:queued { id }` → `pendingRequestId = id`；添加「⏳ 已发送，等待 Claude Code...」消息
  - `design:processing` → 更新最后一条消息为「⚙️ Claude Code 处理中...」
  - `design:done` (action=suggest) → 更新消息为 `content` 文字（若 content 为空则显示「(未返回内容)」）；`pendingRequestId = null`；恢复按钮
  - `design:done` (action=develop) → 更新消息为「✅ 已修改：{changedFiles.join(', ')}」；`pendingRequestId = null`；恢复按钮
  - `design:failed` → 更新消息为「❌ 失败：{error}」；`pendingRequestId = null`；恢复按钮
- UI：移除 `.chat-send` 按钮，新增 `.btn-suggest` 和 `.btn-develop` 两个按钮（竖向排列）

---

## 测试变更

### `tests/unit/queue.spec.ts`

- enqueue 测试：验证 `action` 字段被正确存储（默认 `'develop'`，可传 `'suggest'`）
- complete 测试：验证 `content` 字段被存储（建议模式）
- 现有测试保持不变

### `tests/api/06-design-queue.spec.ts`

- `design:request` 发送时带 `action: 'suggest'`，验证 `design:queued` 返回 id
- `GET /api/next` 返回的 request 包含 `action` 字段
- `POST /api/complete/:id` 带 `content`：验证 `design:done` WS 推送包含 `action: 'suggest'` 和 `content`
- `GET /api/requests/:id` 响应包含 `action` 和 `content` 字段（completed 状态下）

---

## 不在本次范围内

- 配置列表面板（历史记录）
- 深色主题
- `ai:chat` 服务端代码的删除（保留但不从 extension 调用）
