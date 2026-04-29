import { describe, expect, it } from 'bun:test';

import { getRegisteredToolNames, registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

function makeTool(name: string): McpToolDefinition {
  return {
    tool: {
      name,
      description: `tool ${name}`,
      inputSchema: { type: 'object', properties: {} },
    },
    handler: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
  };
}

describe('registerTools', () => {
  it('skips tools with empty names', () => {
    const before = getRegisteredToolNames();
    registerTools([makeTool('')]);
    expect(getRegisteredToolNames()).toEqual(before);
  });

  it('trims names before registration', () => {
    const before = getRegisteredToolNames();
    registerTools([makeTool('  test-trimmed-tool  ')]);
    const after = getRegisteredToolNames();
    expect(after).toContain('test-trimmed-tool');
    expect(after.length).toBe(before.length + 1);
  });
});
