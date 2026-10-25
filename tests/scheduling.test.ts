import { beforeEach, describe, expect, it, vi } from "vitest";
import { pool } from "@/lib/db";
import { istDateString } from "@/lib/time";
import { generateDailySummary, ruleBasedSummary } from "@/server/ai/summary";
import { getReport, summaryMetrics } from "@/server/reports";
import { intakeLead } from "@/server/workflows/lead-intake";
import { markAttendance } from "@/server/workflows/no-show";
import { bookLeadManually, cancelAppointment, listOpenSlots, rescheduleAppointment } from "@/server/workflows/scheduling";
import { drain } from "@/worker/runner";
import { addSlot, futureDate, leadPayload, q, resetData } from "./helpers";

async function booked() {
  const date = futureDate(3);
  await addSlot("DOC-DER-1", date, 10);
  const r = await intakeLead(leadPayload({ preferred_date: date }));
  if (!r.ok) throw new Error("intake failed");
  await drain();
  return { appt: (await q.appointments())[0]!, leadId: r.leadId };
}

beforeEach(resetData);

describe("cancelling an appointment", () => {
  it("frees the slot, stops reminders and tells the patient", async () => {
    const { appt, leadId } = await booked();

    const r = await cancelAppointment(appt.appointment_id, "Doctor unavailable", "staff");
    expect(r.ok).toBe(true);
    await drain();

    const [row] = await q.appointments();
    expect(row).toMatchObject({ status: "cancelled", cancel_reason: "Doctor unavailable", cancelled_by: "staff" });

    const slot = await pool().query(`SELECT status, appointment_id FROM slots WHERE slot_id = $1`, [appt.slot_id]);
    expect(slot.rows[0]).toEqual({ status: "open", appointment_id: null });

    expect((await q.jobs("appointment.reminder")).every((j) => j.status === "cancelled")).toBe(true);
    expect((await q.messages()).some((m) => m.template_name === "APPT_CANCELLED_01" && m.delivery_status === "sent")).toBe(true);
    expect((await q.lead(leadId))!.status).toBe("closed");
  });

  it("frees the slot for someone else to book", async () => {
    const { appt } = await booked();
    await cancelAppointment(appt.appointment_id, "", "staff");

    const r = await intakeLead(leadPayload({ phone: "9800000009", preferred_date: futureDate(3), enquiry_text: "acne consultation please" }));
    if (!r.ok) throw new Error();
    await drain();
    const appts = await q.appointments();
    expect(appts.filter((a) => a.status === "booked")).toHaveLength(1);
    expect(appts.find((a) => a.status === "booked")!.slot_id).toBe(appt.slot_id);
  });

  it("cannot be cancelled twice", async () => {
    const { appt } = await booked();
    expect((await cancelAppointment(appt.appointment_id, "", "staff")).ok).toBe(true);
    const second = await cancelAppointment(appt.appointment_id, "", "staff");
    expect(second).toMatchObject({ ok: false });
    await drain();
    expect((await q.messages()).filter((m) => m.template_name === "APPT_CANCELLED_01")).toHaveLength(1);
  });
});

describe("rescheduling", () => {
  it("moves the appointment, re-times reminders and notifies the patient", async () => {
    const { appt } = await booked();
    const newSlotId = await addSlot("DOC-DER-2", futureDate(5), 16);

    const r = await rescheduleAppointment(appt.appointment_id, newSlotId, "staff");
    expect(r.ok).toBe(true);
    await drain();

    const [row] = await q.appointments();
    expect(row).toMatchObject({ slot_id: newSlotId, doctor_id: "DOC-DER-2", reschedule_count: 1, status: "booked" });
    expect(row!.reminder_24h_at).toBeNull();

    const oldSlot = await pool().query(`SELECT status FROM slots WHERE slot_id = $1`, [appt.slot_id]);
    expect(oldSlot.rows[0].status).toBe("open");

    const reminders = await q.jobs("appointment.reminder");
    expect(reminders.filter((j) => j.status === "cancelled").length).toBeGreaterThan(0);
    expect(reminders.filter((j) => j.status === "queued").length).toBeGreaterThan(0);

    const msg = (await q.messages()).find((m) => m.template_name === "APPT_RESCHEDULED_01")!;
    expect(msg.delivery_status).toBe("sent");
    expect(msg.body).toContain("Dr. Karan Mehta");
  });

  it("refuses a taken slot, another department, or a past slot", async () => {
    const { appt } = await booked();
    const takenByOther = await addSlot("DOC-DER-2", futureDate(4), 11);
    await pool().query(`UPDATE slots SET status = 'booked' WHERE slot_id = $1`, [takenByOther]);
    expect(await rescheduleAppointment(appt.appointment_id, takenByOther, "staff")).toMatchObject({ ok: false, reason: "That slot was just taken" });

    const otherDept = await addSlot("DOC-CAR-1", futureDate(4), 11);
    expect(await rescheduleAppointment(appt.appointment_id, otherDept, "staff")).toMatchObject({ ok: false });

    expect(await rescheduleAppointment(appt.appointment_id, "SLOT-DOES-NOT-EXIST", "staff")).toMatchObject({ ok: false, reason: "Slot not found" });
  });

  it("two staff rescheduling into the same slot: only one wins", async () => {
    const a = await booked();
    const date = futureDate(6);
    await addSlot("DOC-DER-1", date, 9);
    const second = await intakeLead(leadPayload({ phone: "9800000010", preferred_date: date, enquiry_text: "skin check" }));
    if (!second.ok) throw new Error();
    await drain();
    const appts = await q.appointments();
    const target = await addSlot("DOC-DER-2", futureDate(7), 10);

    const results = await Promise.all(appts.map((x) => rescheduleAppointment(x.appointment_id, target, "staff")));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
  });
});

describe("booking a reviewed lead", () => {
  it("books, confirms and resolves the open exception", async () => {
    const r = await intakeLead(leadPayload({ enquiry_text: "hello, I am not sure which doctor I need", department: undefined }));
    if (!r.ok) throw new Error();
    await drain();
    expect((await q.lead(r.leadId))!.status).toBe("needs_review");
    expect((await q.exceptions()).filter((e) => e.status === "open")).toHaveLength(1);

    const slotId = await addSlot("DOC-GEN-1", futureDate(2), 11);
    expect(await bookLeadManually(r.leadId, slotId, "staff")).toMatchObject({ ok: true });
    await drain();

    const lead = await q.lead(r.leadId);
    expect(lead).toMatchObject({ status: "booked", department: "general_medicine" });
    expect((await q.exceptions()).filter((e) => e.status === "open")).toHaveLength(0);
    expect((await q.messages()).some((m) => m.template_name === "APPT_CONFIRM_01")).toBe(true);
    expect((await q.jobs("appointment.reminder")).length).toBeGreaterThan(0);
    expect(await q.auditActions(lead!.correlation_id)).toContain("appointment.booked_by_staff");
  });

  it("refuses to double-book a lead or take a filled slot", async () => {
    const { leadId } = await booked();
    const slotId = await addSlot("DOC-DER-2", futureDate(4), 12);
    expect(await bookLeadManually(leadId, slotId, "staff")).toMatchObject({ ok: false, reason: "This lead already has an appointment" });
  });

  it("lists only open, future slots for staff", async () => {
    await addSlot("DOC-ORT-1", futureDate(2), 10);
    const taken = await addSlot("DOC-ORT-1", futureDate(2), 11);
    await pool().query(`UPDATE slots SET status = 'booked' WHERE slot_id = $1`, [taken]);
    const slots = await listOpenSlots("orthopedics");
    expect(slots).toHaveLength(1);
    expect(slots[0]!.doctor_name).toBe("Dr. Suresh Reddy");
  });
});

describe("management report", () => {
  it("counts the funnel, conversion and automation share", async () => {
    const { appt } = await booked();
    await markAttendance(appt.appointment_id, "attended", "staff");

    const reviewLead = await intakeLead(leadPayload({ phone: "9800000011", enquiry_text: "what are your timings?", department: undefined }));
    if (!reviewLead.ok) throw new Error();
    await drain();
    const staffSlot = await addSlot("DOC-GEN-2", futureDate(3), 12);
    await bookLeadManually(reviewLead.leadId, staffSlot, "staff");
    await drain();

    const report = await getReport(7);
    expect(report.funnel).toMatchObject({ enquiries: 2, auto_booked: 1, staff_booked: 1, attended: 1, conversion_rate: 100, automation_rate: 50 });
    expect(report.response.median_seconds).not.toBeNull();

    const dermatology = report.departments.find((d) => d.department === "Dermatology")!;
    expect(dermatology).toMatchObject({ leads: 1, booked: 1 });

    const instagram = report.sources.find((s) => s.source === "Instagram")!;
    expect(instagram).toMatchObject({ leads: 2, booked: 2, conversion_rate: 100 });

    expect(report.trend).toHaveLength(7);
    expect(report.trend.at(-1)).toMatchObject({ day: istDateString(), leads: 2 });
    expect(report.health.messages_sent).toBeGreaterThan(0);
  });

  it("summary metrics contain no patient identifiers", async () => {
    await booked();
    const metrics = summaryMetrics(await getReport(7));
    const serialized = JSON.stringify(metrics);
    expect(serialized).not.toMatch(/Rahul|9876543210|\+91/);
    expect(metrics).toMatchObject({ enquiries: 1, booked_automatically: 1 });
  });
});

describe("daily management summary", () => {
  it("falls back to a deterministic summary when the AI fails", async () => {
    await booked();
    const metrics = summaryMetrics(await getReport(7));
    const failing = vi.fn(async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;

    process.env.AI_PROVIDER = "openai_compatible";
    process.env.AI_API_KEY = "test-key";
    const { resetEnvCache } = await import("@/lib/env");
    resetEnvCache();
    try {
      const result = await generateDailySummary(metrics, { force: true, fetchImpl: failing });
      expect(result.provider).toBe("rules_fallback");
      expect(result.summary.headline).toContain("1 enquiries");
    } finally {
      process.env.AI_PROVIDER = "rules";
      delete process.env.AI_API_KEY;
      resetEnvCache();
    }
  });

  it("caches per day and can be regenerated", async () => {
    await booked();
    const metrics = summaryMetrics(await getReport(7));
    const first = await generateDailySummary(metrics, { force: true });
    expect(first.cached).toBe(false);
    const second = await generateDailySummary(metrics);
    expect(second.cached).toBe(true);
    const rows = await pool().query(`SELECT count(*)::int AS n FROM daily_summaries`);
    expect(rows.rows[0].n).toBe(1);
  });

  it("describes the numbers without inventing any", () => {
    const summary = ruleBasedSummary({
      period_days: 7,
      enquiries: 10,
      booked_automatically: 6,
      booked_by_staff: 1,
      needing_human_review: 2,
      no_slot_available: 1,
      conversion_rate_percent: 70,
      median_first_response_seconds: 3,
      attended: 5,
      no_shows: 2,
      cancelled: 0,
      messages_sent: 12,
      messages_failed: 1,
      open_exceptions: 3,
      exception_types: [],
      departments: [],
      chronic_patients_enrolled: 0,
      chronic_due_this_week: 0,
      chronic_overdue: 0,
      chronic_reminders_30d: 0,
      lab_reports_awaiting_review: 0,
      lab_abnormal_open: 0,
      lab_patients_told_7d: 0,
    });
    expect(summary.headline).toBe("10 enquiries, 7 booked, 2 no-shows over the last 7 day(s).");
    expect(summary.wins.join(" ")).toContain("3 seconds");
    expect(summary.exceptions.join(" ")).toContain("1 patient messages failed");
    expect(summary.questions_for_management.length).toBeGreaterThan(0);
  });
});

describe("summary caching by period", () => {
  it("keeps a separate summary per reporting period", async () => {
    const { generateDailySummary } = await import("@/server/ai/summary");
    const { getReport, summaryMetrics } = await import("@/server/reports");
    await booked();

    const week = await generateDailySummary(summaryMetrics(await getReport(7)));
    const month = await generateDailySummary(summaryMetrics(await getReport(30)));
    expect(week.summary.headline).toContain("last 7 day(s)");
    expect(month.summary.headline).toContain("last 30 day(s)");
    expect(month.cached).toBe(false);

    const weekAgain = await generateDailySummary(summaryMetrics(await getReport(7)));
    expect(weekAgain.cached).toBe(true);
    expect(weekAgain.summary.headline).toBe(week.summary.headline);
  });
});
