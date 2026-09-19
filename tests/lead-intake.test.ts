import { beforeEach, describe, expect, it } from "vitest";
import { pool } from "@/lib/db";
import { drain } from "@/worker/runner";
import { intakeLead, processLead } from "@/server/workflows/lead-intake";
import { addSlot, futureDate, leadPayload, q, resetData } from "./helpers";

async function intake(overrides: Record<string, unknown> = {}) {
  const r = await intakeLead(leadPayload(overrides));
  if (!r.ok) throw new Error(`intake failed: ${JSON.stringify(r.errors)}`);
  return r;
}

beforeEach(resetData);

describe("Demo 1: lead -> classification -> booking -> confirmation", () => {
  it("books the earliest slot on the preferred date and confirms on WhatsApp", async () => {
    const date = futureDate(2);
    await addSlot("DOC-DER-1", date, 11, 0);
    const early = await addSlot("DOC-DER-2", date, 10, 0);
    await addSlot("DOC-CAR-1", date, 9, 0); // other department, must be ignored

    const r = await intake({ preferred_date: date });
    expect(r.duplicate).toBe(false);
    await drain();

    const lead = await q.lead(r.leadId);
    expect(lead).toMatchObject({ status: "booked", department: "dermatology", priority: "normal", patient_status: "new" });
    expect(lead!.first_response_at).not.toBeNull();

    const [appt] = await q.appointments();
    expect(appt).toMatchObject({ slot_id: early, doctor_id: "DOC-DER-2", lead_id: r.leadId, status: "booked" });
    const slot = await pool().query(`SELECT status, appointment_id FROM slots WHERE slot_id = $1`, [early]);
    expect(slot.rows[0]).toEqual({ status: "booked", appointment_id: appt!.appointment_id });

    const msgs = await q.messages();
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ template_name: "APPT_CONFIRM_01", delivery_status: "sent", recipient: "+919876543210" });
    expect(msgs[0]!.body).toContain("Dr. Karan Mehta");
    expect(msgs[0]!.body).toContain(appt!.appointment_id);

    // Both reminders scheduled in the future, not yet run.
    const reminders = await q.jobs("appointment.reminder");
    expect(reminders.map((j) => j.payload.stage).sort()).toEqual(["24h", "3h"]);
    expect(reminders.every((j) => j.status === "queued")).toBe(true);

    expect(await q.auditActions(r.correlationId)).toEqual([
      "lead.received",
      "lead.classified",
      "appointment.booked",
      "message.sent",
    ]);
    expect(await q.exceptions()).toHaveLength(0);
  });

  it("treats a repeated webhook as the same lead", async () => {
    await addSlot("DOC-DER-1", futureDate(2), 10);
    const a = await intake();
    const b = await intake();
    expect(b).toMatchObject({ leadId: a.leadId, duplicate: true });

    const withCid = await intake({ correlation_id: "HOSP-20260905-DEMO01" });
    const again = await intake({ correlation_id: "HOSP-20260905-DEMO01", enquiry_text: "different text" });
    expect(again).toMatchObject({ leadId: withCid.leadId, duplicate: true });

    const count = await pool().query(`SELECT count(*)::int AS n FROM leads`);
    expect(count.rows[0].n).toBe(2);
  });

  it("creates exactly one lead under concurrent identical submissions", async () => {
    const results = await Promise.allSettled(Array.from({ length: 6 }, () => intakeLead(leadPayload())));
    const ok = results.filter((r) => r.status === "fulfilled").map((r) => (r as PromiseFulfilledResult<any>).value);
    expect(new Set(ok.map((r) => r.leadId)).size).toBe(1);
    const count = await pool().query(`SELECT count(*)::int AS n FROM leads`);
    expect(count.rows[0].n).toBe(1);
  });

  it("never double-books: three leads racing for one slot", async () => {
    const date = futureDate(3);
    await addSlot("DOC-ORT-1", date, 10);
    const leads = await Promise.all(
      ["9800000001", "9800000002", "9800000003"].map((phone) =>
        intake({ phone, department: "Orthopedics", preferred_date: date, enquiry_text: "knee pain appointment" }),
      ),
    );
    await Promise.all(leads.map((l) => processLead(l.leadId)));

    const statuses = await Promise.all(leads.map((l) => q.lead(l.leadId).then((x) => x!.status)));
    expect(statuses.filter((s) => s === "booked")).toHaveLength(1);
    expect(statuses.filter((s) => s === "no_slot")).toHaveLength(2);
    expect(await q.appointments()).toHaveLength(1);
  });

  it("processing a lead twice has no additional effect", async () => {
    await addSlot("DOC-DER-1", futureDate(2), 10);
    await addSlot("DOC-DER-1", futureDate(2), 11);
    const r = await intake();
    await processLead(r.leadId);
    await processLead(r.leadId);
    await drain();
    expect(await q.appointments()).toHaveLength(1);
    expect(await q.messages()).toHaveLength(1);
  });
});

describe("human review paths", () => {
  it("emergency: no booking, emergency message, high-severity exception", async () => {
    await addSlot("DOC-CAR-1", futureDate(2), 10);
    const r = await intake({ department: "Cardiology", enquiry_text: "My father has severe chest pain, need appointment" });
    await drain();

    expect(await q.lead(r.leadId)).toMatchObject({ status: "needs_review", enquiry_type: "emergency", priority: "review" });
    expect(await q.appointments()).toHaveLength(0);
    const [exc] = await q.exceptions();
    expect(exc).toMatchObject({ error_type: "CLINICAL_EMERGENCY_MENTIONED", severity: "high", record_id: r.leadId });
    const [msg] = await q.messages();
    expect(msg).toMatchObject({ template_name: "EMERGENCY_REDIRECT_01", delivery_status: "sent" });
    expect(msg!.body).toContain("108");
  });

  it("clinical question: acknowledged and routed to staff, never answered", async () => {
    const r = await intake({ enquiry_text: "which medicine should I take for my acne?" });
    await drain();
    expect(await q.lead(r.leadId)).toMatchObject({ status: "needs_review", enquiry_type: "clinical_question" });
    expect((await q.exceptions())[0]).toMatchObject({ error_type: "NEEDS_HUMAN_REVIEW", severity: "medium" });
    expect((await q.messages())[0]).toMatchObject({ template_name: "ENQUIRY_ACK_01" });
  });

  it("no slot on the preferred date: exception lists alternatives, patient acknowledged", async () => {
    const date = futureDate(2);
    await addSlot("DOC-DER-1", futureDate(4), 10); // only a later slot exists
    const r = await intake({ preferred_date: date });
    await drain();

    expect(await q.lead(r.leadId)).toMatchObject({ status: "no_slot", department: "dermatology" });
    const [exc] = await q.exceptions();
    expect(exc).toMatchObject({ error_type: "NO_SLOT_AVAILABLE" });
    expect(exc!.details.alternatives).toHaveLength(1);
    expect((await q.messages())[0]).toMatchObject({ template_name: "ENQUIRY_ACK_01" });
  });

  it("missing preferred date goes to review", async () => {
    const r = await intake({ preferred_date: undefined });
    await drain();
    expect(await q.lead(r.leadId)).toMatchObject({ status: "needs_review" });
    expect((await q.exceptions())[0]).toMatchObject({ error_type: "MISSING_PREFERRED_DATE" });
  });

  it("no messaging consent: still books, but does not message and asks staff to call", async () => {
    await addSlot("DOC-DER-1", futureDate(2), 10);
    const r = await intake({ consent: undefined });
    await drain();
    expect(await q.lead(r.leadId)).toMatchObject({ status: "booked" });
    expect((await q.messages())[0]).toMatchObject({ delivery_status: "skipped", skip_reason: "no_messaging_consent" });
    expect((await q.exceptions())[0]).toMatchObject({ error_type: "NO_MESSAGING_CONSENT", severity: "low" });
  });
});

describe("validation", () => {
  it.each([
    [{ phone: "12345" }, "phone"],
    [{ preferred_date: "2020-01-01" }, "preferred_date"],
    [{ preferred_date: "2026-02-30" }, "preferred_date"],
    [{ full_name: "" }, "full_name"],
    [{ enquiry_text: "" }, "enquiry_text"],
    [{ email: "not-an-email" }, "email"],
  ])("rejects %o", async (overrides, field) => {
    const r = await intakeLead(leadPayload(overrides));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(Object.keys(r.errors)).toContain(field);
  });

  it("marks returning patients as existing", async () => {
    await intake();
    const second = await intake({ enquiry_text: "another visit please" });
    expect((await q.lead(second.leadId))!.patient_status).toBe("existing");
  });
});
