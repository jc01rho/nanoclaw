/**
 * Audit/rate-limit rows for the unknown-sender report relay.
 *
 * These rows deliberately do NOT model approval state and are never used to
 * add an unknown sender as a member. They only prevent notification spam and
 * preserve the original report payload for operator review.
 */
import { getDb } from '../../../db/connection.js';

export interface PendingReportRelay {
  id: string;
  messaging_group_id: string;
  agent_group_id: string;
  sender_identity: string;
  sender_name: string | null;
  original_message: string;
  report_session_id: string | null;
  created_at: string;
}

export function createPendingReportRelay(row: PendingReportRelay): void {
  getDb()
    .prepare(
      `INSERT INTO pending_report_relays (
         id, messaging_group_id, agent_group_id, sender_identity,
         sender_name, original_message, report_session_id, created_at
       )
       VALUES (
         @id, @messaging_group_id, @agent_group_id, @sender_identity,
         @sender_name, @original_message, @report_session_id, @created_at
       )`,
    )
    .run(row);
}

export function hasRecentReportRelay(messagingGroupId: string, senderIdentity: string, since: string): boolean {
  const row = getDb()
    .prepare(
      `SELECT 1 AS x
       FROM pending_report_relays
       WHERE messaging_group_id = ?
         AND sender_identity = ?
         AND created_at >= ?
       LIMIT 1`,
    )
    .get(messagingGroupId, senderIdentity, since) as { x: number } | undefined;
  return row !== undefined;
}
