import { audit } from "@/lib/audit";
import { one, pool, tx, type Db } from "@/lib/db";
import { raiseException } from "@/lib/exceptions";
import { newId } from "@/lib/ids";
import { cancelQueuedJobs } from "@/lib/jobs";
import { normalizeIndianPhone } from "@/lib/phone";
import { checkSafety } from "@/server/ai/safety";

/**
 * The inbound half of WhatsApp: delivery receipts and patient replies.
 *
 * Until a provider reports back, a message is only "handed over" — we do not know whether it
 * reached anyone. These handlers close that loop, and deal with the two things patients
 * actually send back: a reply, or a request to stop being messaged.
 *
 * Nothing here answers the patient. The system does not hold conversations: a reply becomes
 * work for a person, and a reply that sounds clinical becomes urgent work.
 */

/** Status can only move forward. A late 'sent' must not overwrite a 'read'. */
const STATUS_RANK: Record<string, number> = { sending: 0, sent: 1, delivered: 2, read: 3 };

export type DeliveryStatus = "sent" | "delivered" | "read" | "failed";

export interface StatusUpdate {
  providerMessageId: string;
  status: DeliveryStatus;
  timestamp?: Date;
  error?: string;
}

export type StatusResult = "updated" | "ignored_out_of_order" | "unknown_message";

export async function applyDeliveryStatus(update: StatusUpdate, db: Db = pool()): Promise<StatusResult> {
  const row = await one<{
    message_id: string;
    delivery_status: string;
    patient_id: string | null;
    template_name: string;
    correlation_id: string | null;
  }>(
    db,
    `SELECT message_id, delivery_status, patient_id, template_name, correlation_id
     FROM communication_log WHERE provider_message_id = $1`,
    [update.providerMessageId],
  );
  if (!row) return "unknown_message";

  if (update.status === "failed") {
    await db.query(
      `UPDATE communication_log SET delivery_status = 'failed', error = $2, updated_at = now()
       WHERE message_id = $1`,
      [row.message_id, (update.error ?? "provider reported failure").slice(0, 500)],
    );
    // A message the hospital believes went out but did not is worth a person's attention:
    // a patient may be waiting for a confirmation that never arrived.
    await raiseException(db, {
      workflow: "messaging",
      errorType: "MESSAGE_DELIVERY_FAILED",
      severity: "medium",
      summary: `WhatsApp could not deliver ${row.template_name} to the patient. Contact them another way.`,
      recordId: row.message_id,
      correlationId: row.correlation_id,
      details: { error: update.error ?? null },
      dedupeKey: `delivery-failed:${row.message_id}`,
    });
    await audit(db, {
      workflow: "messaging",
      actor: "integration",
      action: "message.delivery_failed",
      recordId: row.message_id,
      correlationId: row.correlation_id,
      details: { error: update.error ?? null },
    });
    return "updated";
  }

  const current = STATUS_RANK[row.delivery_status] ?? -1;
  const incoming = STATUS_RANK[update.status] ?? -1;
  if (incoming <= current) return "ignored_out_of_order";

  const at = update.timestamp ?? new Date();
  await db.query(
    `UPDATE communication_log SET
       delivery_status = $2,
       delivered_at = CASE WHEN $2 IN ('delivered','read') AND delivered_at IS NULL THEN $3 ELSE delivered_at END,
       read_at = CASE WHEN $2 = 'read' AND read_at IS NULL THEN $3 ELSE read_at END,
       updated_at = now()
     WHERE message_id = $1`,
    [row.message_id, update.status, at],
  );
  return "updated";
}

/**
 * Opt-out and opt-in keywords.
 *
 * Deliberately broad on opting out and narrow on opting back in: wrongly stopping messages
 * is an inconvenience, wrongly resuming them is a complaint and, under the DPDP Act, a
 * consent problem.
 */
const OPT_OUT = /\b(stop|stopall|unsubscribe|opt\s*out|remove me|no more messages?|band karo|mat bhejo|message mat|nahi chahiye|vaddu)\b/i;
const OPT_IN = /^\s*(start|resume|subscribe|yes start)\s*$/i;

export interface InboundMessage {
  providerMessageId: string;
  from: string;
  text: string;
  timestamp?: Date;
}

export type InboundOutcome = "opt_out" | "opt_in" | "escalated" | "staff_review" | "duplicate" | "unknown_sender";

export async function handleInboundMessage(message: InboundMessage, db: Db = pool()): Promise<InboundOutcome> {
  const phone = normalizeIndianPhone(message.from) ?? (message.from.startsWith("+") ? message.from : `+${message.from}`);
  const text = message.text.trim();

  return tx(async (c) => {
    const patient = await one<{ patient_id: string; full_name: string; consent_status: string }>(
      c,
      `SELECT patient_id, full_name, consent_status FROM patients WHERE phone = $1`,
      [phone],
    );

    // Meta retries webhooks; the provider's id makes this idempotent.
    const inserted = await one<{ inbound_id: string }>(
      c,
      `INSERT INTO inbound_messages (inbound_id, provider_message_id, patient_id, from_number, body, received_at)
       VALUES ($1, $2, $3, $4, $5, COALESCE($6, now()))
       ON CONFLICT (provider_message_id) DO NOTHING
       RETURNING inbound_id`,
      [newId("IN"), message.providerMessageId, patient?.patient_id ?? null, phone, text, message.timestamp ?? null],
    );
    if (!inserted) return "duplicate";

    const finish = async (outcome: InboundOutcome) => {
      await c.query(`UPDATE inbound_messages SET handled_as = $2 WHERE inbound_id = $1`, [inserted.inbound_id, outcome]);
      return outcome;
    };

    if (!patient) {
      // Someone messaging the hospital number who is not in the system. A person reads it.
      await raiseException(c, {
        workflow: "messaging",
        errorType: "MESSAGE_FROM_UNKNOWN_NUMBER",
        severity: "low",
        summary: `A WhatsApp message arrived from ${phone}, which is not a known patient.`,
        details: { text: text.slice(0, 500) },
        owner: "front_desk",
        dedupeKey: `inbound-unknown:${inserted.inbound_id}`,
      });
      return finish("unknown_sender");
    }

    // The safety net applies to every channel. A patient who replies to a reminder saying
    // they are bleeding must be treated exactly as if they had said it on the enquiry form.
    const safety = checkSafety(text);
    if (safety.emergency || safety.clinicalQuestion) {
      await raiseException(c, {
        workflow: "messaging",
        errorType: safety.emergency ? "INBOUND_EMERGENCY" : "INBOUND_CLINICAL_QUESTION",
        severity: safety.emergency ? "high" : "medium",
        summary: safety.emergency
          ? `${patient.full_name} described a possible emergency by WhatsApp. Call the patient now.`
          : `${patient.full_name} asked a clinical question by WhatsApp. A clinician should reply.`,
        recordId: patient.patient_id,
        details: { text: text.slice(0, 500), safety_flags: safety.flags },
        owner: safety.emergency ? "on_call_desk" : "front_desk",
        dedupeKey: `inbound-clinical:${inserted.inbound_id}`,
      });
      await audit(c, {
        workflow: "messaging",
        actor: "patient",
        action: "inbound.escalated",
        recordId: patient.patient_id,
        details: { reason: safety.emergency ? "emergency" : "clinical_question", flags: safety.flags },
      });
      return finish("escalated");
    }

    if (OPT_OUT.test(text)) {
      await c.query(
        `UPDATE patients SET consent_status = 'denied', consent_updated_at = now(), consent_source = 'whatsapp_reply',
                             updated_at = now()
         WHERE patient_id = $1`,
        [patient.patient_id],
      );
      // Anything already queued for this patient must not go out after they asked us to stop.
      await cancelQueuedJobs(c, `job:msg:${patient.patient_id}`);
      const cancelled = await c.query(
        `UPDATE jobs SET status = 'cancelled', updated_at = now()
         WHERE status = 'queued' AND payload->>'patient_id' = $1`,
        [patient.patient_id],
      );
      await audit(c, {
        workflow: "messaging",
        actor: "patient",
        action: "consent.withdrawn",
        recordId: patient.patient_id,
        details: { channel: "whatsapp", cancelled_jobs: cancelled.rowCount ?? 0 },
      });
      await raiseException(c, {
        workflow: "messaging",
        errorType: "PATIENT_OPTED_OUT",
        severity: "low",
        summary: `${patient.full_name} asked to stop receiving WhatsApp messages. Contact them by phone instead.`,
        recordId: patient.patient_id,
        owner: "front_desk",
        dedupeKey: `opt-out:${patient.patient_id}`,
      });
      return finish("opt_out");
    }

    if (OPT_IN.test(text)) {
      await c.query(
        `UPDATE patients SET consent_status = 'granted', consent_updated_at = now(), consent_source = 'whatsapp_reply',
                             updated_at = now()
         WHERE patient_id = $1`,
        [patient.patient_id],
      );
      await audit(c, {
        workflow: "messaging",
        actor: "patient",
        action: "consent.granted",
        recordId: patient.patient_id,
        details: { channel: "whatsapp" },
      });
      return finish("opt_in");
    }

    // Anything else: the system does not reply, a person does.
    await raiseException(c, {
      workflow: "messaging",
      errorType: "PATIENT_REPLIED",
      severity: "medium",
      summary: `${patient.full_name} replied on WhatsApp: "${text.slice(0, 160)}"`,
      recordId: patient.patient_id,
      details: { text: text.slice(0, 500) },
      owner: "front_desk",
      dedupeKey: `inbound-reply:${inserted.inbound_id}`,
    });
    await audit(c, {
      workflow: "messaging",
      actor: "patient",
      action: "inbound.received",
      recordId: patient.patient_id,
      details: { length: text.length },
    });
    return finish("staff_review");
  });
}

/** Meta's webhook payload, reduced to the two things we act on. */
export interface WhatsAppWebhookPayload {
  entry?: {
    changes?: {
      value?: {
        statuses?: { id?: string; status?: string; timestamp?: string; errors?: { title?: string; message?: string }[] }[];
        messages?: { id?: string; from?: string; timestamp?: string; type?: string; text?: { body?: string } }[];
      };
    }[];
  }[];
}

export interface ProcessResult {
  statuses: number;
  messages: number;
  outcomes: InboundOutcome[];
}

/** Applies everything in one webhook delivery. Meta batches several events per call. */
export async function processWhatsAppWebhook(payload: WhatsAppWebhookPayload, db: Db = pool()): Promise<ProcessResult> {
  const result: ProcessResult = { statuses: 0, messages: 0, outcomes: [] };

  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      for (const status of change.value?.statuses ?? []) {
        if (!status.id || !status.status) continue;
        const mapped = status.status === "failed" ? "failed" : status.status;
        if (!["sent", "delivered", "read", "failed"].includes(mapped)) continue;
        await applyDeliveryStatus(
          {
            providerMessageId: status.id,
            status: mapped as DeliveryStatus,
            timestamp: status.timestamp ? new Date(Number(status.timestamp) * 1000) : undefined,
            error: status.errors?.[0]?.message ?? status.errors?.[0]?.title,
          },
          db,
        );
        result.statuses++;
      }

      for (const message of change.value?.messages ?? []) {
        if (!message.id || !message.from) continue;
        // Only text is handled; an image or voice note still becomes work for a person.
        const text = message.type === "text" ? (message.text?.body ?? "") : `[${message.type ?? "unsupported"} message]`;
        const outcome = await handleInboundMessage(
          {
            providerMessageId: message.id,
            from: message.from,
            text,
            timestamp: message.timestamp ? new Date(Number(message.timestamp) * 1000) : undefined,
          },
          db,
        );
        result.messages++;
        result.outcomes.push(outcome);
      }
    }
  }
  return result;
}
