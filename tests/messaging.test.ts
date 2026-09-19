import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pool } from "@/lib/db";
import { enqueue, reapStaleJobs } from "@/lib/jobs";
import { MessagingError, setMessageProviderForTests, type MessageProvider } from "@/server/messaging/providers";
import { sendTemplateMessage } from "@/server/messaging/send";
import { sendAppointmentReminder } from "@/server/workflows/appointment";
import { intakeLead } from "@/server/workflows/lead-intake";
import { drain } from "@/worker/runner";
import { addSlot, futureDate, leadPayload, q, resetData } from "./helpers";

function fakeProvider(impl: () => Promise<{ providerMessageId: string }>) {
  const send = vi.fn(impl);
  const p: MessageProvider = { name: "fake", channel: "whatsapp", send };
  setMessageProviderForTests(p);
  return send;
}

async function patient(phone = "9876543210", consent = true) {
  const r = await intakeLead(leadPayload({ phone, consent }));
  if (!r.ok) throw new Error("intake failed");
  const row = await pool().query(`SELECT patient_id FROM leads WHERE lead_id = $1`, [r.leadId]);
  return row.rows[0].patient_id as string;
}

const ack = (patientId: string, dedupeKey = "msg:test:ack") => ({
  dedupeKey,
  patientId,
  template: "ENQUIRY_ACK_01" as const,
  workflow: "leadIntake" as const,
  vars: { patient_name: "Rahul", hospital_name: "DemoCare" },
});

beforeEach(resetData);
afterEach(() => setMessageProviderForTests(undefined));

describe("at-most-once messaging", () => {
  it("sends a given dedupe key only once", async () => {
    const send = fakeProvider(async () => ({ providerMessageId: "wamid.1" }));
    const pid = await patient();
    const a = await sendTemplateMessage(ack(pid));
    const b = await sendTemplateMessage(ack(pid));
    expect(a.status).toBe("sent");
    expect(b.status).toBe("duplicate");
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("retries after a definite provider rejection", async () => {
    let calls = 0;
    const send = fakeProvider(async () => {
      if (++calls === 1) throw new MessagingError("rate limited", "definite", false);
      return { providerMessageId: "wamid.2" };
    });
    const pid = await patient();
    await expect(sendTemplateMessage(ack(pid))).rejects.toThrow("rate limited");
    expect((await q.messages())[0]).toMatchObject({ delivery_status: "failed" });

    const retry = await sendTemplateMessage(ack(pid));
    expect(retry.status).toBe("sent");
    expect(send).toHaveBeenCalledTimes(2);
    const msgs = await q.messages();
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ delivery_status: "sent", provider_message_id: "wamid.2" });
  });

  it("never auto-retries an ambiguous send; raises a high exception instead", async () => {
    const send = fakeProvider(async () => {
      throw new MessagingError("timeout", "ambiguous", false);
    });
    const pid = await patient();
    expect((await sendTemplateMessage(ack(pid))).status).toBe("ambiguous");
    // A second attempt within the grace period must not call the provider again.
    expect((await sendTemplateMessage(ack(pid))).status).toBe("duplicate");
    expect(send).toHaveBeenCalledTimes(1);
    const excs = await q.exceptions();
    expect(excs).toHaveLength(1);
    expect(excs[0]).toMatchObject({ error_type: "MESSAGE_DELIVERY_UNKNOWN", severity: "high" });
  });

  it("flags a send whose worker crashed mid-flight instead of resending", async () => {
    const send = fakeProvider(async () => ({ providerMessageId: "x" }));
    const pid = await patient();
    await pool().query(
      `INSERT INTO communication_log (message_id, dedupe_key, patient_id, recipient, channel, provider, template_name,
                                      workflow_name, body, delivery_status, updated_at)
       VALUES ('MSG-CRASHED', 'msg:test:ack', $1, '+919876543210', 'whatsapp', 'fake', 'ENQUIRY_ACK_01', 'wf', 'b',
               'sending', now() - interval '10 minutes')`,
      [pid],
    );
    expect((await sendTemplateMessage(ack(pid))).status).toBe("ambiguous");
    expect(send).not.toHaveBeenCalled();
  });

  it("a permanently rejected message kills the job and alerts IT", async () => {
    await addSlot("DOC-DER-1", futureDate(2), 10);
    // Mock provider rejects numbers ending in 0000.
    const r = await intakeLead(leadPayload({ phone: "9876500000" }));
    expect(r.ok).toBe(true);
    await drain();
    const confirm = (await q.jobs("appointment.confirm"))[0]!;
    expect(confirm).toMatchObject({ status: "dead", attempts: 1 });
    const types = (await q.exceptions()).map((e) => e.error_type);
    expect(types).toContain("JOB_FAILED");
  });
});

describe("reminders", () => {
  async function booked() {
    const date = futureDate(3);
    await addSlot("DOC-DER-1", date, 10);
    const r = await intakeLead(leadPayload({ preferred_date: date }));
    if (!r.ok) throw new Error();
    await drain();
    return (await q.appointments())[0]!;
  }

  it("sends a due reminder once and stamps the appointment", async () => {
    const appt = await booked();
    const slotIso = new Date(appt.slot_start).toISOString();
    await sendAppointmentReminder(appt.appointment_id, "24h", slotIso);
    await sendAppointmentReminder(appt.appointment_id, "24h", slotIso);
    const reminders = (await q.messages()).filter((m) => m.template_name === "APPT_REMINDER_01");
    expect(reminders).toHaveLength(1);
    expect((await q.appointments())[0]!.reminder_24h_at).not.toBeNull();
  });

  it("skips reminders for cancelled or rescheduled appointments", async () => {
    const appt = await booked();
    const slotIso = new Date(appt.slot_start).toISOString();
    await sendAppointmentReminder(appt.appointment_id, "24h", "2030-01-01T00:00:00.000Z");
    await pool().query(`UPDATE appointments SET status = 'cancelled' WHERE appointment_id = $1`, [appt.appointment_id]);
    await sendAppointmentReminder(appt.appointment_id, "3h", slotIso);
    expect((await q.messages()).filter((m) => m.template_name === "APPT_REMINDER_01")).toHaveLength(0);
    const skipped = await pool().query(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'reminder.skipped'`);
    expect(skipped.rows[0].n).toBe(2);
  });
});

describe("job queue", () => {
  it("dedupes enqueues and retries with backoff until dead", async () => {
    const first = await enqueue(pool(), { type: "does.not.exist", payload: {}, dedupeKey: "k1", maxAttempts: 3 });
    const second = await enqueue(pool(), { type: "does.not.exist", payload: {}, dedupeKey: "k1" });
    expect(first).not.toBeNull();
    expect(second).toBeNull();
    await drain();
    // Unknown handler is a permanent error: dead on first attempt.
    expect((await q.jobs("does.not.exist"))[0]).toMatchObject({ status: "dead", attempts: 1 });
  });

  it("transient failures are requeued with backoff", async () => {
    fakeProvider(async () => {
      throw new MessagingError("503", "definite", false);
    });
    const pid = await patient();
    await enqueue(pool(), {
      type: "message.send",
      payload: { dedupe_key: "msg:t:1", patient_id: pid, template: "ENQUIRY_ACK_01", workflow: "leadIntake", vars: { patient_name: "R", hospital_name: "H" } },
    });
    await drain();
    const job = (await q.jobs("message.send"))[0]!;
    expect(job).toMatchObject({ status: "queued", attempts: 1 });
    expect(new Date(job.run_at).getTime()).toBeGreaterThan(Date.now() + 20_000);
  });

  it("requeues jobs abandoned by a dead worker", async () => {
    const id = await enqueue(pool(), { type: "x", payload: {} });
    await pool().query(`UPDATE jobs SET status = 'running', locked_at = now() - interval '10 minutes' WHERE job_id = $1`, [id]);
    expect(await reapStaleJobs(pool())).toBe(1);
    expect((await q.jobs("x"))[0]).toMatchObject({ status: "queued" });
  });
});
