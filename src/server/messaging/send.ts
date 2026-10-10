import { audit } from "@/lib/audit";
import { one, pool } from "@/lib/db";
import { env } from "@/lib/env";
import { raiseException } from "@/lib/exceptions";
import { normalizeIndianPhone } from "@/lib/phone";
import { newId } from "@/lib/ids";
import type { WorkflowKey } from "@/lib/workflows";
import { WORKFLOWS } from "@/lib/workflows";
import { getMessageProvider, MessagingError } from "./providers";
import { renderTemplate, type TemplateName } from "./templates";

export interface SendRequest {
  /** Unique per logical message, e.g. msg:APT-123:APPT_REMINDER_01:24h. Guarantees at-most-once delivery. */
  dedupeKey: string;
  patientId: string;
  template: TemplateName;
  vars: Record<string, string>;
  workflow: WorkflowKey;
  correlationId?: string | null;
  /** When set, the lead's first_response_at is stamped on first successful send. */
  leadId?: string | null;
}

export type SendOutcome =
  | { status: "sent"; messageId: string }
  | { status: "skipped"; reason: string }
  | { status: "duplicate"; messageId: string }
  | { status: "ambiguous"; messageId: string };

/** The numbers real messages may go to, or null when no allowlist is configured. */
export function allowedRecipients(raw: string | undefined): Set<string> | null {
  if (!raw?.trim()) return null;
  const numbers = raw
    // Commas, semicolons or new lines separate numbers; spaces belong inside "90529 96536".
    .split(/[,;\n]+/)
    .map((n) => normalizeIndianPhone(n))
    .filter((n): n is string => !!n);
  // A list that parses to nothing must block everything, not silently allow everyone.
  return new Set(numbers);
}

/** How long a 'sending' row may sit before we conclude its sender crashed. */
const IN_FLIGHT_GRACE_SECONDS = 120;

interface LogRow {
  message_id: string;
  delivery_status: string;
  age_seconds: number;
}

/**
 * Sends a template message with at-most-once semantics.
 *
 * - Checks consent before anything is sent.
 * - Claims the dedupe key in communication_log BEFORE calling the provider.
 * - A definite provider failure marks the row 'failed' and rethrows so the job can retry.
 * - An ambiguous outcome (timeout, crash) is never retried automatically: it raises an
 *   exception for staff, because a blind retry could message the patient twice.
 */
export async function sendTemplateMessage(req: SendRequest): Promise<SendOutcome> {
  const db = pool();
  const provider = getMessageProvider();
  const { body, params } = renderTemplate(req.template, req.vars);

  const patient = await one<{ phone: string; consent_status: string }>(
    db,
    `SELECT phone, consent_status FROM patients WHERE patient_id = $1`,
    [req.patientId],
  );
  if (!patient) throw new Error(`Patient ${req.patientId} not found`);

  const base = [req.dedupeKey, req.patientId, patient.phone, provider.channel, provider.name, req.template, WORKFLOWS[req.workflow].name, body, req.correlationId ?? null];

  if (patient.consent_status !== "granted") {
    const inserted = await one<{ message_id: string }>(
      db,
      `INSERT INTO communication_log (message_id, dedupe_key, patient_id, recipient, channel, provider, template_name,
                                      workflow_name, body, correlation_id, delivery_status, skip_reason)
       VALUES ($10, $1, $2, $3, $4, $5, $6, $7, $8, $9, 'skipped', 'no_messaging_consent')
       ON CONFLICT (dedupe_key) DO NOTHING RETURNING message_id`,
      [...base, newId("MSG")],
    );
    if (inserted) {
      await raiseException(db, {
        workflow: req.workflow,
        errorType: "NO_MESSAGING_CONSENT",
        severity: "low",
        summary: `Patient has not consented to WhatsApp messages; ${req.template} was not sent. Contact by phone.`,
        recordId: req.patientId,
        correlationId: req.correlationId,
        dedupeKey: `no-consent:${req.dedupeKey}`,
      });
      await audit(db, {
        workflow: req.workflow,
        actor: "system",
        action: "message.skipped_no_consent",
        recordId: inserted.message_id,
        correlationId: req.correlationId,
        details: { template: req.template },
      });
    }
    return { status: "skipped", reason: "no_messaging_consent" };
  }

  // A test number or a demo should reach only the people who agreed to receive it. The mock
  // provider is exempt: it sends nothing.
  const allowed = provider.name === "mock" ? null : allowedRecipients(env().WA_ALLOWED_RECIPIENTS);
  if (allowed && !allowed.has(patient.phone)) {
    const inserted = await one<{ message_id: string }>(
      db,
      `INSERT INTO communication_log (message_id, dedupe_key, patient_id, recipient, channel, provider, template_name,
                                      workflow_name, body, correlation_id, delivery_status, skip_reason)
       VALUES ($10, $1, $2, $3, $4, $5, $6, $7, $8, $9, 'skipped', 'not_on_allowlist')
       ON CONFLICT (dedupe_key) DO NOTHING RETURNING message_id`,
      [...base, newId("MSG")],
    );
    if (inserted) {
      await audit(db, {
        workflow: req.workflow,
        actor: "system",
        action: "message.skipped_not_on_allowlist",
        recordId: inserted.message_id,
        correlationId: req.correlationId,
        details: { template: req.template },
      });
    }
    return { status: "skipped", reason: "not_on_allowlist" };
  }

  // Claim the dedupe key. Exactly one caller wins.
  const messageId = newId("MSG");
  const claimed = await one<{ message_id: string }>(
    db,
    `INSERT INTO communication_log (message_id, dedupe_key, patient_id, recipient, channel, provider, template_name,
                                    workflow_name, body, correlation_id, delivery_status)
     VALUES ($10, $1, $2, $3, $4, $5, $6, $7, $8, $9, 'sending')
     ON CONFLICT (dedupe_key) DO NOTHING RETURNING message_id`,
    [...base, messageId],
  );

  let activeId: string;
  if (claimed) {
    activeId = claimed.message_id;
  } else {
    const existing = (await one<LogRow>(
      db,
      `SELECT message_id, delivery_status, EXTRACT(EPOCH FROM now() - updated_at)::int AS age_seconds
       FROM communication_log WHERE dedupe_key = $1`,
      [req.dedupeKey],
    ))!;
    if (existing.delivery_status === "failed") {
      // A previous attempt was definitively rejected: safe to try again. Re-claim atomically.
      const reclaimed = await one<{ message_id: string }>(
        db,
        `UPDATE communication_log SET delivery_status = 'sending', error = NULL, updated_at = now()
         WHERE dedupe_key = $1 AND delivery_status = 'failed' RETURNING message_id`,
        [req.dedupeKey],
      );
      if (!reclaimed) return { status: "duplicate", messageId: existing.message_id };
      activeId = reclaimed.message_id;
    } else if (existing.delivery_status === "sending" && existing.age_seconds > IN_FLIGHT_GRACE_SECONDS) {
      // The previous sender died mid-send. We cannot know if the patient got it.
      await flagAmbiguous(req, existing.message_id, "Previous send attempt did not complete; delivery unknown.");
      return { status: "ambiguous", messageId: existing.message_id };
    } else {
      return { status: "duplicate", messageId: existing.message_id };
    }
  }

  try {
    const { providerMessageId } = await provider.send({ to: patient.phone, template: req.template, params, body });
    await db.query(
      `UPDATE communication_log SET delivery_status = 'sent', provider_message_id = $2, sent_at = now(), updated_at = now()
       WHERE message_id = $1`,
      [activeId, providerMessageId],
    );
    if (req.leadId) {
      await db.query(
        `UPDATE leads SET first_response_at = COALESCE(first_response_at, now()), updated_at = now() WHERE lead_id = $1`,
        [req.leadId],
      );
    }
    await audit(db, {
      workflow: req.workflow,
      actor: "system",
      action: "message.sent",
      recordId: activeId,
      correlationId: req.correlationId,
      details: { template: req.template, provider: provider.name },
    });
    return { status: "sent", messageId: activeId };
  } catch (err) {
    if (err instanceof MessagingError && err.kind === "definite") {
      await db.query(
        `UPDATE communication_log SET delivery_status = 'failed', error = $2, updated_at = now() WHERE message_id = $1`,
        [activeId, err.message.slice(0, 1000)],
      );
      throw err;
    }
    await flagAmbiguous(req, activeId, (err as Error).message);
    return { status: "ambiguous", messageId: activeId };
  }
}

async function flagAmbiguous(req: SendRequest, messageId: string, detail: string) {
  const db = pool();
  await raiseException(db, {
    workflow: req.workflow,
    errorType: "MESSAGE_DELIVERY_UNKNOWN",
    severity: "high",
    summary: `Could not confirm whether ${req.template} reached the patient. Check the provider dashboard before resending.`,
    recordId: messageId,
    correlationId: req.correlationId,
    details: { detail, dedupe_key: req.dedupeKey },
    dedupeKey: `ambiguous:${req.dedupeKey}`,
  });
  await audit(db, {
    workflow: req.workflow,
    actor: "system",
    action: "message.delivery_unknown",
    recordId: messageId,
    correlationId: req.correlationId,
    details: { detail },
  });
}
