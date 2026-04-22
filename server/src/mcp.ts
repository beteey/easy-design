/**
 * MCP stdio server — exposes design request tools to Claude Code.
 *
 * Tools:
 *   watch_design_requests   — long-poll GET /api/next, returns DesignRequest | null
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
        'Call this after handling the request. ' +
        'status must be "completed" or "failed". ' +
        'For suggest mode: provide content (advice text). ' +
        'For develop mode: provide summary (what changed) and changedFiles (file paths). ' +
        'On failed: provide error (reason).',
      inputSchema: {
        type: 'object' as const,
        properties: {
          id: { type: 'string', description: 'Request ID returned by watch_design_requests' },
          status: { type: 'string', enum: ['completed', 'failed'] },
          content: { type: 'string', description: 'Text content for suggest mode (returned as advice text to the user)' },
          summary: { type: 'string', description: 'Human-readable description of the change (develop mode)' },
          changedFiles: {
            type: 'array',
            items: { type: 'string' },
            description: 'Relative paths of files modified (develop mode)',
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
      typeof args?.['timeout_ms'] === 'number' ? (args['timeout_ms'] as number) : 30_000,
      60_000,
    )
    try {
      const res = await fetch(`${SERVER_URL}/api/next?timeout=${timeoutMs}`)
      if (!res.ok) throw new Error(`Server responded ${res.status}`)
      const body = await res.json() as { ok: boolean; request: unknown }
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(body.request, null, 2) }],
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return {
        content: [{
          type: 'text' as const,
          text: `Error: cannot reach design-easily server. Please run: npm run dev:server\n(${msg})`,
        }],
        isError: true,
      }
    }
  }

  if (name === 'complete_design_request') {
    const { id, status, summary, changedFiles, error, content } = args as {
      id: string
      status: 'completed' | 'failed'
      summary?: string
      changedFiles?: string[]
      error?: string
      content?: string
    }
    try {
      const res = await fetch(`${SERVER_URL}/api/complete/${id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status, summary, changedFiles, error, content }),
      })
      const body = await res.json() as { ok: boolean; error?: string }
      if (!res.ok) {
        return {
          content: [{ type: 'text' as const, text: `Server rejected completion: ${body.error ?? res.status}` }],
          isError: true,
        }
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(body) }] }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return {
        content: [{
          type: 'text' as const,
          text: `Error: cannot reach design-easily server.\n(${msg})`,
        }],
        isError: true,
      }
    }
  }

  return {
    content: [{ type: 'text' as const, text: `Unknown tool: ${name}` }],
    isError: true,
  }
})

const transport = new StdioServerTransport()
await server.connect(transport)
// Log to stderr only — stdout is reserved for MCP protocol
process.stderr.write('design-easily MCP server started\n')
