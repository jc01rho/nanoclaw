/**
 * MCP tools barrel — imports each tool module for its side-effect
 * `registerTools([...])` call, then starts the MCP server.
 *
 * Adding a new tool module: create the file, call `registerTools([...])`
 * at module scope, and append the import here. No central list.
 */
import './core.js';
import './scheduling.js';
import './interactive.js';
import './agents.js';
import './self-mod.js';
import { startMcpServer } from './server.js';

function log(msg: string): void {
  console.error(`[mcp-tools] ${msg}`);
}

// CRITICAL: Every tool handler is declared async, so a thrown exception
// becomes an unhandled promise rejection. Without process-level handlers:
// - The MCP server child process dies (Claude SDK does not auto-restart)
// - Every mcp__nanoclaw__* tool becomes unresponsive until the agent group is restarted
process.on('uncaughtException', (err) => {
  log(`Uncaught exception in MCP server: ${err.message}`);
});

process.on('unhandledRejection', (reason) => {
  log(`Unhandled rejection in MCP server: ${reason instanceof Error ? reason.message : String(reason)}`);
});

startMcpServer().catch((err) => {
  log(`MCP server error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
