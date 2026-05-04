import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'bun:test';

import {
  createArchiveSlug,
  getToolAllowlist,
  isToolAllowedByRuntimePolicy,
  preToolUseHook,
  quarantineEmptyToolNameTranscripts,
  transcriptHasEmptyToolUseName,
} from './claude.js';

const tempDirs: string[] = [];

const invokePreToolUseHook = preToolUseHook as unknown as (input: unknown) => Promise<unknown>;

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  delete process.env.NANOCLAW_RUNTIME_POLICY;
});

describe('Claude provider guards', () => {
  it('blocks undefined tool names in PreToolUse hook', async () => {
    const result = (await invokePreToolUseHook({ tool_name: undefined })) as { decision?: string; stopReason?: string };
    expect(result.decision).toBe('block');
    expect(result.stopReason).toContain('Tool name is empty');
  });

  it('blocks blank tool names in PreToolUse hook', async () => {
    const result = (await invokePreToolUseHook({ tool_name: '   ' })) as { decision?: string; stopReason?: string };
    expect(result.decision).toBe('block');
    expect(result.stopReason).toContain('Tool name is empty');
  });

  it('creates non-empty archive slug for Korean-only summary', () => {
    const slug = createArchiveSlug('모니터링 결과 보고');
    expect(slug.length).toBeGreaterThan(0);
    expect(slug.startsWith('conversation-')).toBe(true);
  });

  it('detects transcript lines with empty tool_use names', () => {
    const transcript = [
      JSON.stringify({ type: 'user', message: { content: 'hello' } }),
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'working' },
            { type: 'tool_use', id: 'call_1', name: '', input: { todos: [] } },
          ],
        },
      }),
    ].join('\n');
    expect(transcriptHasEmptyToolUseName(transcript)).toBe(true);
  });

  it('does not flag transcripts with valid tool_use names', () => {
    const transcript = JSON.stringify({
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', id: 'call_1', name: 'TodoWrite', input: { todos: [] } }],
      },
    });
    expect(transcriptHasEmptyToolUseName(transcript)).toBe(false);
  });

  it('quarantines transcript files with empty tool_use names', () => {
    const claudeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-claude-'));
    tempDirs.push(claudeHome);
    const projectDir = path.join(claudeHome, 'projects', '-workspace-agent');
    fs.mkdirSync(projectDir, { recursive: true });
    const transcriptPath = path.join(projectDir, 'bad.jsonl');
    fs.writeFileSync(
      transcriptPath,
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 'call_1', name: '', input: {} }] },
      }),
    );

    const quarantined = quarantineEmptyToolNameTranscripts(claudeHome);

    expect(quarantined).toHaveLength(1);
    expect(fs.existsSync(transcriptPath)).toBe(false);
    expect(fs.existsSync(quarantined[0])).toBe(true);
  });
});

describe('Runtime policy allowlist', () => {
  it('returns full allowlist for default policy', () => {
    const allowlist = getToolAllowlist('default');
    expect(allowlist).toContain('Bash');
    expect(allowlist).toContain('Write');
    expect(allowlist).toContain('Edit');
    expect(allowlist).toContain('Task');
    expect(allowlist).toContain('mcp__nanoclaw__*');
  });

  it('returns safe-only allowlist for public_guest_k8s policy', () => {
    const allowlist = getToolAllowlist('public_guest_k8s');
    expect(allowlist).not.toContain('Bash');
    expect(allowlist).not.toContain('Write');
    expect(allowlist).not.toContain('Edit');
    expect(allowlist).not.toContain('Task');
    expect(allowlist).not.toContain('TeamCreate');
    expect(allowlist).not.toContain('TeamDelete');
    expect(allowlist).not.toContain('mcp__nanoclaw__*');
    expect(allowlist).toContain('Read');
    expect(allowlist).toContain('Glob');
    expect(allowlist).toContain('Grep');
    expect(allowlist).toContain('WebSearch');
    expect(allowlist).toContain('WebFetch');
    expect(allowlist).toContain('mcp__nanoclaw__safe_restart_pod');
  });

  it('blocks dangerous tools for public_guest_k8s policy', () => {
    expect(isToolAllowedByRuntimePolicy('Bash', 'public_guest_k8s')).toBe(false);
    expect(isToolAllowedByRuntimePolicy('Write', 'public_guest_k8s')).toBe(false);
    expect(isToolAllowedByRuntimePolicy('Edit', 'public_guest_k8s')).toBe(false);
    expect(isToolAllowedByRuntimePolicy('Task', 'public_guest_k8s')).toBe(false);
    expect(isToolAllowedByRuntimePolicy('TeamCreate', 'public_guest_k8s')).toBe(false);
    expect(isToolAllowedByRuntimePolicy('mcp__nanoclaw__schedule_task', 'public_guest_k8s')).toBe(false);
    expect(isToolAllowedByRuntimePolicy('mcp__nanoclaw__install_packages', 'public_guest_k8s')).toBe(false);
    expect(isToolAllowedByRuntimePolicy('mcp__nanoclaw__add_mcp_server', 'public_guest_k8s')).toBe(false);
  });

  it('allows only explicit k8s MCP tools for public_guest_k8s policy', () => {
    expect(isToolAllowedByRuntimePolicy('Read', 'public_guest_k8s')).toBe(true);
    expect(isToolAllowedByRuntimePolicy('mcp__nanoclaw__k8s_get', 'public_guest_k8s')).toBe(true);
    expect(isToolAllowedByRuntimePolicy('mcp__nanoclaw__k8s_describe', 'public_guest_k8s')).toBe(true);
    expect(isToolAllowedByRuntimePolicy('mcp__nanoclaw__k8s_logs', 'public_guest_k8s')).toBe(true);
    expect(isToolAllowedByRuntimePolicy('mcp__nanoclaw__safe_restart_pod', 'public_guest_k8s')).toBe(true);
    expect(isToolAllowedByRuntimePolicy('mcp__nanoclaw__delete_pod', 'public_guest_k8s')).toBe(false);
  });

  it('fails closed for public_guest_k8s when config is not loaded', async () => {
    process.env.NANOCLAW_RUNTIME_POLICY = 'public_guest_k8s';
    const result = (await invokePreToolUseHook({ tool_name: 'Bash' })) as { decision?: string; stopReason?: string };
    expect(result.decision).toBe('block');
    expect(result.stopReason).toContain('public_guest_k8s');
  });
});
