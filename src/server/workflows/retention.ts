import { audit } from "@/lib/audit";
import { one, pool, tx, type Db } from "@/lib/db";
import { env } from "@/lib/env";
import { istDateString } from "@/lib/time";

/**
 * Data retention.
 *
 * The DPDP Act 2023 says personal data should not be kept longer than the purpose needs.
 * This removes the patient's own words once they have served that purpose, while keeping the
 * operational record the hospital must be able to show:
 *
 *   redacted  — message bodies, free-text enquiries, inbound replies
 *   kept      — that a message was sent, to whom, which template, when, and its outcome
 *   untouched — the audit log, which never contained patient content in the first place
 *
 * The result is a system that can answer "did you contact this patient, and when" years
 * later without still holding what they told you.
 */

export const REDACTED = "[redacted by retention policy]";

export interface RetentionResult {
  ranForDate: string;
  messagesRedacted: number;
  enquiriesCleared: number;
  inboundCleared: number;
  skipped: boolean;
}

/**
 * Purges anything past its retention window. Safe to run repeatedly: already-redacted rows
 * are skipped, and a second run on the same day is a no-op.
 */
export async function runRetention(opts: { force?: boolean; now?: Date } = {}, db: Db = pool()): Promise<RetentionResult> {
  const e = env();
  const day = istDateString(opts.now ?? new Date());
  const empty: RetentionResult = {
    ranForDate: day,
    messagesRedacted: 0,
    enquiriesCleared: 0,
    inboundCleared: 0,
    skipped: true,
  };

  if (!e.RETENTION_ENABLED) return empty;

  return tx(async (c) => {
    if (!opts.force) {
      const already = await one<{ run_id: number }>(c, `SELECT run_id FROM retention_runs WHERE ran_for_date = $1`, [day]);
      if (already) return empty;
    }

    const messages = await c.query(
      `UPDATE communication_log SET body = $2, updated_at = now()
       WHERE created_at < now() - make_interval(days => $1) AND body <> $2`,
      [e.RETENTION_MESSAGE_DAYS, REDACTED],
    );

    const enquiries = await c.query(
      `UPDATE leads SET enquiry_text = $2, updated_at = now()
       WHERE created_at < now() - make_interval(days => $1) AND enquiry_text <> $2`,
      [e.RETENTION_ENQUIRY_DAYS, REDACTED],
    );

    const inbound = await c.query(
      `UPDATE inbound_messages SET body = $2
       WHERE received_at < now() - make_interval(days => $1) AND body IS NOT NULL AND body <> $2`,
      [e.RETENTION_MESSAGE_DAYS, REDACTED],
    );

    const result: RetentionResult = {
      ranForDate: day,
      messagesRedacted: messages.rowCount ?? 0,
      enquiriesCleared: enquiries.rowCount ?? 0,
      inboundCleared: inbound.rowCount ?? 0,
      skipped: false,
    };

    await c.query(
      `INSERT INTO retention_runs (ran_for_date, messages_redacted, enquiries_cleared, inbound_cleared)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (ran_for_date) DO UPDATE SET
         messages_redacted = retention_runs.messages_redacted + EXCLUDED.messages_redacted,
         enquiries_cleared = retention_runs.enquiries_cleared + EXCLUDED.enquiries_cleared,
         inbound_cleared = retention_runs.inbound_cleared + EXCLUDED.inbound_cleared,
         ran_at = now()`,
      [day, result.messagesRedacted, result.enquiriesCleared, result.inboundCleared],
    );

    await audit(c, {
      workflow: "system",
      actor: "system",
      action: "retention.ran",
      details: {
        message_days: e.RETENTION_MESSAGE_DAYS,
        enquiry_days: e.RETENTION_ENQUIRY_DAYS,
        ...result,
      },
    });

    return result;
  });
}

/** Last few runs, for the dashboard and for showing a hospital that the policy runs. */
export async function recentRetentionRuns(limit = 10, db: Db = pool()) {
  const r = await db.query(
    `SELECT ran_for_date, messages_redacted, enquiries_cleared, inbound_cleared, ran_at
     FROM retention_runs ORDER BY ran_for_date DESC LIMIT $1`,
    [limit],
  );
  return r.rows;
}
