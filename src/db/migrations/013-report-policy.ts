import type Database from 'better-sqlite3';

import type { Migration } from './index.js';

/**
 * Unknown-sender report relay support.
 *
 * `messaging_groups.unknown_sender_policy` is a TEXT column, so the new
 * `report` value does not require a schema rewrite. The table below records
 * relayed reports and provides a cheap recent-report lookup for rate limiting.
 */
export const migration013: Migration = {
  version: 13,
  name: 'report-policy',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS pending_report_relays (
        id                 TEXT PRIMARY KEY,
        messaging_group_id TEXT NOT NULL REFERENCES messaging_groups(id),
        agent_group_id     TEXT NOT NULL REFERENCES agent_groups(id),
        sender_identity    TEXT NOT NULL,
        sender_name        TEXT,
        original_message   TEXT NOT NULL,
        report_session_id  TEXT,
        created_at         TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_pending_report_relays_recent
        ON pending_report_relays(messaging_group_id, sender_identity, created_at);
    `);
  },
};
