/**
 * MCP server bootstrap + tool self-registration.
 *
 * Each tool module calls `registerTools([...])` at import time. The
 * barrel (`index.ts`) imports every tool module for side effects, then
 * calls `startMcpServer()` which uses whatever was registered.
 *
 * Default when only `core.ts` is imported: the core `send_message` /
 * `send_file` / `edit_message` / `add_reaction` tools are available.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import type { McpToolDefinition } from './types.js';

function log(msg: string): void {
  console.error(`[mcp-tools] ${msg}`);
}

const allTools: McpToolDefinition[] = [];
const toolMap = new Map<string, McpToolDefinition>();

export function getRegisteredToolNames(): string[] {
  return allTools.map((t) => t.tool.name);
}

export function registerTools(tools: McpToolDefinition[]): void {
  for (const t of tools) {
    const name = t.tool.name?.trim();
    if (!name) {
      log('Warning: attempted to register a tool with an empty name, skipping');
      continue;
    }
    if (name !== t.tool.name) {
      t.tool.name = name;
    }
    if (toolMap.has(name)) {
      log(`Warning: tool "${name}" already registered, skipping duplicate`);
      continue;
    }
    allTools.push(t);
    toolMap.set(name, t);
  }
}

export async function startMcpServer(): Promise<void> {
  const server = new Server({ name: 'nanoclaw', version: '2.0.0' }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: allTools.map((t) => t.tool),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const tool = toolMap.get(name);
    if (!tool) {
      return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
    }
    // Wrap handler in try-catch: any throw here becomes an unhandled
    // promise rejection, which (without a process-level handler) takes
    // down the MCP server child process — and Claude SDK does not
    // auto-restart it, so every mcp__nanoclaw__* tool goes dark until
    // the agent group is restarted. Catch and surface as a tool error
    // so the server stays alive.
    try {
      return await tool.handler(args ?? {});
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`Tool "${name}" threw: ${message}`);
      return {
        content: [{ type: 'text', text: `Error in ${name}: ${message}` }],
        isError: true,
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log(`MCP server started with ${allTools.length} tools: ${allTools.map((t) => t.tool.name).join(', ')}`);
}
