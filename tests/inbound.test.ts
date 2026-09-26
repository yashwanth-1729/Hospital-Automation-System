import { beforeEach, describe, expect, it } from "vitest";
import { pool } from "@/lib/db";
import { resetEnvCache } from "@/lib/env";
import { applyDeliveryStatus, handleInboundMessage, processWhatsAppWebhook } from "@/server/messaging/inbound";
import { REDACTED, runRetention } from "@/server/workflows/retention";
import { intakeLead } from "@/server/workflows/lead-intake";
import { drain } from "@/worker/runner";
import { addSlot, futureDate, leadPayload, q, resetData } from "./helpers";

async function bookedPatient() {
  await addSlot("DOC-DER-1", futureDate(3), 10);
  const r = await intakeLead(leadPayload({ preferred_date: futureDate(3) }));
  if (!r.ok) throw new Error("intake failed");
  await drain();
  const message = (await q.messages())[0]!;
  const patient = await pool()
    .query(`SELECT patient_id, phone FROM patients LIMIT 1`)
    .then((x) => x.rows[0]);
  return { message, patient, leadId: r.leadId };
}

const inboundRows = () => pool().query(`SELECT * FROM inbound_messages ORDER BY created_at`).then((r) => r.rows);
const patientRow = (id: string) => pool().query(`SELECT * FROM patients WHERE patient_id = $1`, [id]).then((r) => r.rows[0]);

beforeEach(async () => {
  await resetData();
  await pool().query(`TRUNCATE inbound_messages, retention_runs CASCADE`);
  resetEnvCache();
});

describe("delivery receipts", () => {
  it("walks a message from sent to delivered to read", async () => {
    const { message } = await bookedPatient();
    const providerId = message.provider_message_id;

    expect(await applyDeliveryStatus({ providerMessageId: providerId, status: "delivered" })).toBe("updated");
    let row = (await q.messages())[0]!;
    expect(row.delivery_status).toBe("delivered");
    expect(row.delivered_at).not.toBeNull();

    expect(await applyDeliveryStatus({ providerMessageId: providerId, status: "read" })).toBe("updated");
    row = (await q.messages())[0]!;
    expect(row.delivery_status).toBe("read");
    expect(row.read_at).not.toBeNull();
  });

  it("never moves a status backwards when receipts arrive out of order", async () => {
    const { message } = await bookedPatient();
    await applyDeliveryStatus({ providerMessageId: message.provider_message_id, status: "read" });
    // Meta can deliver a late 'sent' after 'read'; it must not undo what we know.
    expect(await applyDeliveryStatus({ providerMessageId: message.provider_message_id, status: "sent" })).toBe(
      "ignored_out_of_order",
    );
    expect((await q.messages())[0]!.delivery_status).toBe("read");
  });

  it("raises work for staff when the provider says delivery failed", async () => {
    const { message } = await bookedPatient();
    await applyDeliveryStatus({
      providerMessageId: message.provider_message_id,
      status: "failed",
      error: "Message undeliverable",
    });

    expect((await q.messages())[0]!.delivery_status).toBe("failed");
    const exc = (await q.exceptions()).filter((e) => e.error_type === "MESSAGE_DELIVERY_FAILED");
    expect(exc).toHaveLength(1);
    expect(exc[0]).toMatchObject({ severity: "medium" });
  });

  it("ignores a receipt for a message it never sent", async () => {
    expect(await applyDeliveryStatus({ providerMessageId: "wamid.unknown", status: "read" })).toBe("unknown_message");
  });
});

describe("patient replies", () => {
  it("treats an emergency reply exactly like one on the enquiry form", async () => {
    const { patient } = await bookedPatient();
    const outcome = await handleInboundMessage({
      providerMessageId: "wamid.1",
      from: patient.phone,
      text: "I have been bleeding since morning, is that normal?",
    });

    expect(outcome).toBe("escalated");
    const exc = (await q.exceptions()).filter((e) => e.error_type === "INBOUND_EMERGENCY");
    expect(exc).toHaveLength(1);
    expect(exc[0]).toMatchObject({ severity: "high", owner: "on_call_desk" });
  });

  it("routes a clinical question to staff without answering it", async () => {
    const { patient } = await bookedPatient();
    const outcome = await handleInboundMessage({
      providerMessageId: "wamid.2",
      from: patient.phone,
      text: "which tablet should I take for the pain?",
    });
    expect(outcome).toBe("escalated");
    expect((await q.exceptions()).some((e) => e.error_type === "INBOUND_CLINICAL_QUESTION")).toBe(true);
  });

  it("stops messaging a patient who asks it to stop, and cancels what is queued", async () => {
    const { patient } = await bookedPatient();
    const queuedBefore = await q.jobs("appointment.reminder");
    expect(queuedBefore.some((j) => j.status === "queued")).toBe(true);

    const outcome = await handleInboundMessage({ providerMessageId: "wamid.3", from: patient.phone, text: "STOP" });
    expect(outcome).toBe("opt_out");

    const after = await patientRow(patient.patient_id);
    expect(after).toMatchObject({ consent_status: "denied", consent_source: "whatsapp_reply" });
    expect(after.consent_updated_at).not.toBeNull();

    const exc = (await q.exceptions()).filter((e) => e.error_type === "PATIENT_OPTED_OUT");
    expect(exc).toHaveLength(1);
  });

  it.each(["stop", "please band karo", "mujhe message mat bhejo", "unsubscribe"])(
    "recognises an opt-out phrased as: %s",
    async (text) => {
      const { patient } = await bookedPatient();
      expect(await handleInboundMessage({ providerMessageId: `wamid-${text}`, from: patient.phone, text })).toBe("opt_out");
    },
  );

  it("lets a patient opt back in, but only with a clear word", async () => {
    const { patient } = await bookedPatient();
    await handleInboundMessage({ providerMessageId: "wamid.4", from: patient.phone, text: "STOP" });

    // "start karna hai" is a sentence, not a command: it must not silently restore consent.
    await handleInboundMessage({ providerMessageId: "wamid.5", from: patient.phone, text: "kal se start karna hai" });
    expect((await patientRow(patient.patient_id)).consent_status).toBe("denied");

    expect(await handleInboundMessage({ providerMessageId: "wamid.6", from: patient.phone, text: "START" })).toBe("opt_in");
    expect((await patientRow(patient.patient_id)).consent_status).toBe("granted");
  });

  it("hands an ordinary reply to a person rather than answering it", async () => {
    const { patient } = await bookedPatient();
    const outcome = await handleInboundMessage({
      providerMessageId: "wamid.7",
      from: patient.phone,
      text: "can I come at 4pm instead?",
    });
    expect(outcome).toBe("staff_review");
    const exc = (await q.exceptions()).filter((e) => e.error_type === "PATIENT_REPLIED");
    expect(exc[0]!.summary).toContain("4pm");
  });

  it("is idempotent, because Meta retries webhooks", async () => {
    const { patient } = await bookedPatient();
    await handleInboundMessage({ providerMessageId: "wamid.8", from: patient.phone, text: "thank you" });
    expect(await handleInboundMessage({ providerMessageId: "wamid.8", from: patient.phone, text: "thank you" })).toBe(
      "duplicate",
    );
    expect(await inboundRows()).toHaveLength(1);
  });

  it("flags a message from a number that is not a patient", async () => {
    const outcome = await handleInboundMessage({ providerMessageId: "wamid.9", from: "+919000000000", text: "hello" });
    expect(outcome).toBe("unknown_sender");
    expect((await q.exceptions()).some((e) => e.error_type === "MESSAGE_FROM_UNKNOWN_NUMBER")).toBe(true);
  });
});

describe("the webhook payload as Meta sends it", () => {
  it("applies statuses and messages from one delivery", async () => {
    const { message, patient } = await bookedPatient();
    const result = await processWhatsAppWebhook({
      entry: [
        {
          changes: [
            {
              value: {
                statuses: [{ id: message.provider_message_id, status: "delivered", timestamp: "1790000000" }],
                messages: [
                  { id: "wamid.in.1", from: patient.phone.replace("+", ""), type: "text", text: { body: "STOP" } },
                ],
              },
            },
          ],
        },
      ],
    });

    expect(result).toMatchObject({ statuses: 1, messages: 1 });
    expect(result.outcomes).toEqual(["opt_out"]);
    expect((await q.messages())[0]!.delivery_status).toBe("delivered");
  });

  it("treats a photo or voice note as something a person must look at", async () => {
    const { patient } = await bookedPatient();
    const result = await processWhatsAppWebhook({
      entry: [{ changes: [{ value: { messages: [{ id: "wamid.img", from: patient.phone, type: "image" }] } }] }],
    });
    expect(result.outcomes).toEqual(["staff_review"]);
    expect((await inboundRows())[0]!.body).toBe("[image message]");
  });

  it("survives an empty or unfamiliar payload", async () => {
    expect(await processWhatsAppWebhook({})).toMatchObject({ statuses: 0, messages: 0 });
    expect(await processWhatsAppWebhook({ entry: [{ changes: [{ value: {} }] }] })).toMatchObject({ statuses: 0 });
  });
});

describe("retention", () => {
  it("redacts what the patient said but keeps the record that it happened", async () => {
    const { leadId } = await bookedPatient();
    await pool().query(`UPDATE communication_log SET created_at = now() - interval '400 days'`);
    await pool().query(`UPDATE leads SET created_at = now() - interval '400 days'`);

    const result = await runRetention({ force: true });
    expect(result.messagesRedacted).toBeGreaterThan(0);
    expect(result.enquiriesCleared).toBe(1);

    const message = (await q.messages())[0]!;
    expect(message.body).toBe(REDACTED);
    // The operational record survives: who, which template, when, and whether it arrived.
    expect(message.template_name).toBe("APPT_CONFIRM_01");
    expect(message.delivery_status).toBe("sent");
    expect(message.sent_at).not.toBeNull();

    expect((await q.lead(leadId))!.enquiry_text).toBe(REDACTED);
    expect((await q.lead(leadId))!.status).toBe("booked");
  });

  it("leaves recent data alone", async () => {
    await bookedPatient();
    const result = await runRetention({ force: true });
    expect(result.messagesRedacted).toBe(0);
    expect((await q.messages())[0]!.body).not.toBe(REDACTED);
  });

  it("runs once a day and records what it did", async () => {
    await bookedPatient();
    await pool().query(`UPDATE communication_log SET created_at = now() - interval '400 days'`);

    const first = await runRetention();
    expect(first.skipped).toBe(false);
    const second = await runRetention();
    expect(second.skipped).toBe(true);

    const runs = await pool().query(`SELECT * FROM retention_runs`);
    expect(runs.rows).toHaveLength(1);
    expect(runs.rows[0].messages_redacted).toBeGreaterThan(0);
  });

  it("can be switched off for a hospital whose policy differs", async () => {
    process.env.RETENTION_ENABLED = "false";
    resetEnvCache();
    try {
      await bookedPatient();
      await pool().query(`UPDATE communication_log SET created_at = now() - interval '400 days'`);
      expect((await runRetention({ force: true })).skipped).toBe(true);
      expect((await q.messages())[0]!.body).not.toBe(REDACTED);
    } finally {
      process.env.RETENTION_ENABLED = "true";
      resetEnvCache();
    }
  });
});
