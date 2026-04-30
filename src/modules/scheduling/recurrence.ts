/**
 * Sweep hook for recurring tasks.
 *
 * Every sweep tick, find `messages_in` rows that are `completed` AND still
 * have a `recurrence` cron expression. For each, compute the next run via
 * cron-parser, insert a fresh pending row (copying series_id forward), then
 * clear the recurrence on the original so it isn't re-cloned next tick.
 *
 * Called from `src/host-sweep.ts` inside `MODULE-HOOK:scheduling-recurrence`.
 * When scheduling ships inline (current state through PR #7), the hook is a
 * direct dynamic import. When scheduling moves to the modules branch in
 * PR #8, the install skill re-fills the marker on install.
 */
import type Database from 'better-sqlite3';

import { TIMEZONE } from '../../config.js';
import { log } from '../../log.js';
import type { Session } from '../../types.js';
import { clearRecurrence, getCompletedRecurring, insertRecurrence } from './db.js';

const MAX_RECURRENCE_ADVANCE_ATTEMPTS = 10;

export async function handleRecurrence(inDb: Database.Database, session: Session): Promise<void> {
  const recurring = getCompletedRecurring(inDb);

  for (const msg of recurring) {
    try {
      const { CronExpressionParser } = await import('cron-parser');
      // Interpret the cron expression in the user's timezone. v1 did this
      // (src/v1/task-scheduler.ts:20-49); without it, a task written "0 9 * * *"
      // by an agent running in a user's local TZ fires at 09:00 UTC instead of
      // 09:00 user-local.
      const interval = CronExpressionParser.parse(msg.recurrence, { tz: TIMEZONE });
      const nextRun = nextRunIso(interval, shouldSkipWeekends(msg.content));
      const prefix = msg.kind === 'task' ? 'task' : 'msg';
      const newId = `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      insertRecurrence(inDb, msg, newId, nextRun);
      clearRecurrence(inDb, msg.id);

      log.info('Inserted next recurrence', {
        originalId: msg.id,
        newId,
        seriesId: msg.series_id,
        nextRun,
        sessionId: session.id,
      });
    } catch (err) {
      log.error('Failed to compute next recurrence', {
        messageId: msg.id,
        recurrence: msg.recurrence,
        err,
      });
    }
  }
}

function shouldSkipWeekends(content: string): boolean {
  try {
    const parsed = JSON.parse(content) as { skipWeekends?: unknown };
    return parsed.skipWeekends === true;
  } catch {
    return false;
  }
}

function nextRunIso(
  interval: { next(): { toDate(): Date; toISOString(): string | null } },
  skipWeekends: boolean,
): string {
  for (let attempt = 0; attempt < MAX_RECURRENCE_ADVANCE_ATTEMPTS; attempt++) {
    const next = interval.next();
    if (!skipWeekends || !isWeekendInConfiguredTimezone(next.toDate())) {
      const iso = next.toISOString();
      if (!iso) throw new Error('cron-parser returned an empty next-run timestamp');
      return iso;
    }
  }

  throw new Error('could not find a non-weekend recurrence within the search window');
}

function isWeekendInConfiguredTimezone(date: Date): boolean {
  const weekday = new Intl.DateTimeFormat('en-US', { timeZone: TIMEZONE, weekday: 'short' }).format(date);
  return weekday === 'Sat' || weekday === 'Sun';
}
