/**
 * Integration tests for the unknown-sender report relay flow.
 *
 * Covers the security-critical invariant that `unknown_sender_policy='report'`
 * relays the message for owner review without admitting the sender as a
 * member of the target agent group.
 */
import fs from 'fs';
import Database from 'better-sqlite3';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

import {
  closeDb,
  createAgentGroup,
  createMessagingGroup,
  createMessagingGroupAgent,
  initTestDb,
  runMigrations,
} from '../../db/index.js';
import { inboundDbPath } from '../../session-manager.js';

vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
}));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-sender-report' };
});

const TEST_DIR = '/tmp/nanoclaw-test-sender-report';

function now(): string {
  return new Date().toISOString();
}

beforeEach(async () => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = initTestDb();
  runMigrations(db);

  createAgentGroup({ id: 'ag-1', name: 'Agent', folder: 'agent', agent_provider: null, created_at: now() });
  createMessagingGroup({
    id: 'mg-chat',
    channel_type: 'discord',
    platform_id: 'guild:channel',
    name: 'Support Channel',
    is_group: 1,
    unknown_sender_policy: 'report',
    created_at: now(),
  });
  createMessagingGroupAgent({
    id: 'mga-1',
    messaging_group_id: 'mg-chat',
    agent_group_id: 'ag-1',
    engage_mode: 'pattern',
    engage_pattern: '.',
    sender_scope: 'all',
    ignored_message_policy: 'drop',
    session_mode: 'shared',
    priority: 0,
    created_at: now(),
  });
  await import('./index.js');

  const { wakeContainer } = await import('../../container-runner.js');
  (wakeContainer as unknown as ReturnType<typeof vi.fn>).mockClear();
});

afterEach(() => {
  closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

function stranger(text: string) {
  return {
    channelType: 'discord',
    platformId: 'guild:channel',
    threadId: null,
    message: {
      id: `stranger-${Math.random().toString(36).slice(2, 8)}`,
      kind: 'chat' as const,
      content: JSON.stringify({
        author: { userId: 'stranger-1', fullName: 'Stranger' },
        text,
      }),
      timestamp: now(),
    },
  };
}

describe('unknown-sender report relay flow', () => {
  it('relays report messages without adding the sender as a member', async () => {
    const { routeInbound } = await import('../../router.js');
    const { getDb } = await import('../../db/connection.js');
    const { wakeContainer } = await import('../../container-runner.js');

    await routeInbound(stranger('Longhorn volume is degraded'));
    await new Promise((r) => setTimeout(r, 20));

    const member = getDb()
      .prepare('SELECT 1 AS x FROM agent_group_members WHERE user_id = ? AND agent_group_id = ?')
      .get('discord:stranger-1', 'ag-1');
    expect(member).toBeUndefined();

    const reporter = getDb().prepare('SELECT * FROM agent_groups WHERE folder = ?').get('report-evaluator') as
      | { id: string }
      | undefined;
    expect(reporter).toBeDefined();

    const reportRow = getDb().prepare('SELECT * FROM pending_report_relays').get() as { report_session_id: string };
    expect(reportRow.report_session_id).toBeTruthy();

    const reportSession = getDb()
      .prepare('SELECT messaging_group_id, thread_id FROM sessions WHERE id = ?')
      .get(reportRow.report_session_id) as { messaging_group_id: string | null; thread_id: string | null };
    expect(reportSession.messaging_group_id).toBe('mg-chat');
    expect(reportSession.thread_id).toBeNull();

    const inbound = new Database(inboundDbPath(reporter!.id, reportRow.report_session_id));
    const messages = inbound.prepare('SELECT kind, content FROM messages_in').all() as Array<{
      kind: string;
      content: string;
    }>;
    inbound.close();

    expect(messages).toHaveLength(1);
    expect(messages[0].kind).toBe('task');
    const payload = JSON.parse(messages[0].content) as {
      type: string;
      prompt: string;
      originPlatformId: string;
      originAgentGroupFolder: string;
      originWorkspacePath: string;
    };
    expect(payload.type).toBe('unknown_sender_report');
    expect(payload.originPlatformId).toBe('guild:channel');
    expect(payload.originAgentGroupFolder).toBe('agent');
    expect(payload.originWorkspacePath).toBe('/workspace/groups/agent');
    expect(payload.prompt).toContain('<@593604865771438083>');
    expect(payload.prompt).toContain('원 채널/스레드');
    expect(payload.prompt).toContain('/workspace/groups/agent');
    expect(wakeContainer).toHaveBeenCalledTimes(1);
  });

  it('rate-limits repeat reports from the same sender and channel', async () => {
    const { routeInbound } = await import('../../router.js');
    const { getDb } = await import('../../db/connection.js');
    const { wakeContainer } = await import('../../container-runner.js');

    await routeInbound(stranger('first report'));
    await new Promise((r) => setTimeout(r, 20));
    await routeInbound(stranger('second report'));
    await new Promise((r) => setTimeout(r, 20));

    const count = (getDb().prepare('SELECT COUNT(*) AS c FROM pending_report_relays').get() as { c: number }).c;
    expect(count).toBe(1);
    expect(wakeContainer).toHaveBeenCalledTimes(1);
  });

  it('also relays non-admin incident reports from public channels while allowing normal routing', async () => {
    const { routeInbound } = await import('../../router.js');
    const { getDb, updateMessagingGroup } = await import('../../db/index.js');
    const { wakeContainer } = await import('../../container-runner.js');

    updateMessagingGroup('mg-chat', { unknown_sender_policy: 'public' });

    await routeInbound(stranger('nexus 죽은것같습니다. teamcity 도 이상해요 gitlab 접속이 안되네요'));
    await new Promise((r) => setTimeout(r, 20));

    const reportRow = getDb().prepare('SELECT * FROM pending_report_relays').get() as { report_session_id: string };
    expect(reportRow.report_session_id).toBeTruthy();

    const reporter = getDb().prepare('SELECT * FROM agent_groups WHERE folder = ?').get('report-evaluator') as
      | { id: string }
      | undefined;
    expect(reporter).toBeDefined();

    const inbound = new Database(inboundDbPath(reporter!.id, reportRow.report_session_id));
    const messages = inbound.prepare('SELECT kind, content FROM messages_in').all() as Array<{
      kind: string;
      content: string;
    }>;
    inbound.close();

    const payload = JSON.parse(messages[0].content) as { type: string; prompt: string };
    expect(payload.type).toBe('unknown_sender_report');
    expect(payload.prompt).toContain('<@593604865771438083>');
    expect(wakeContainer).toHaveBeenCalledTimes(2);
  });

  it('relays public-channel infrastructure complaints even without explicit service names', async () => {
    const { routeInbound } = await import('../../router.js');
    const { getDb, updateMessagingGroup } = await import('../../db/index.js');

    updateMessagingGroup('mg-chat', { unknown_sender_policy: 'public' });

    await routeInbound(stranger('인프라 장애 불만이 있어요. 서비스가 계속 이상하고 접속이 잘 안됩니다.'));
    await new Promise((r) => setTimeout(r, 20));

    const count = (getDb().prepare('SELECT COUNT(*) AS c FROM pending_report_relays').get() as { c: number }).c;
    expect(count).toBe(1);
  });
});
