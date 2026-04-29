import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'bun:test';

import {
  createArchiveSlug,
  preToolUseHook,
  quarantineEmptyToolNameTranscripts,
  transcriptHasEmptyToolUseName,
} from './claude.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('Claude provider guards', () => {
  it('blocks undefined tool names in PreToolUse hook', async () => {
    const result = (await preToolUseHook({})) as { decision?: string; stopReason?: string };
    expect(result.decision).toBe('block');
    expect(result.stopReason).toContain('Tool name is empty');
  });

  it('blocks blank tool names in PreToolUse hook', async () => {
    const result = (await preToolUseHook({ tool_name: '   ' })) as { decision?: string; stopReason?: string };
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
