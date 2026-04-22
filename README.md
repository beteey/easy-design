# easy-design

网页端设计辅助插件 — 在浏览器上选择元素，输入修改意见，AI 直接帮你改代码。

## 功能

- **元素选择** — 鼠标悬停高亮，点击选中网页元素
- **侧边信息面板** — 显示选中元素的组件层级、属性、样式
- **AI 辅助修改** — 输入修改意见，自动生成代码改动
- **一键打开 VS Code** — 跳转到对应源码位置

## 项目结构

```
easy-design/
├── extension/           # 浏览器扩展（content script）
│   └── src/content/
│       ├── inspect.ts   # 元素选择、高亮、面板 UI
│       └── ws.ts        # WebSocket 客户端
├── server/              # Express + WebSocket 后端
│   └── src/
│       ├── app.ts       # 应用入口
│       ├── mcp.ts       # MCP 协议处理
│       └── queue.ts     # 设计请求队列
├── tests/               # 测试文件
│   ├── api/
│   └── unit/
└── docs/                # 设计与规划文档
```

## 技术栈

- **前端**: TypeScript, WebSocket, DOM
- **后端**: Node.js, Express, WebSocket Server
- **协议**: MCP (Model Context Protocol)
- **测试**: Playwright, Vitest

## 开发

```bash
# 安装依赖
npm install

# 安装 Playwright
npx playwright install

# 运行测试
npm test
```

## 架构

```
┌─────────────────┐     WebSocket      ┌─────────────────┐
│  Browser Page   │ ←───────────────→  │   Server        │
│  (content script)│                   │   (Express + WS) │
└─────────────────┘                    └────────┬────────┘
                                                │
                                           MCP  │  AI
                                                ↓
                                           ┌─────────┐
                                           │ Claude  │
                                           └─────────┘
```

## 相关资源

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code)
- [MCP 协议](https://modelcontextprotocol.io/)