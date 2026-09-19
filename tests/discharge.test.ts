import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pool } from "@/lib/db";
import { resetEnvCache } from "@/lib/env";
import { addDays, istDateString } from "@/lib/time";
import {
  getFeedbackRequest,
  recordDischarge,
  requestFeedback,
  sendDischargeReminder,
  submitFeedback,
} from "@/server/workflows/discharge";
import { drain } from "@/worker/runner";
import { q, resetData } from "./helpers";

function dischargePayload(overrides: Record<string, unknown> = {}) {
  return {
    full_name: "Sunita Deshmukh",
    phone: "9876500011",
    department: "Cardiology",
    encounter_id: "IP-2026-0912",
    approved_followup_date: addDays(istDateString(), 7),
    approved_by: "Dr. Ananya Rao",
    approved_followup_window: "Morning OPD",
    consent: true,
    source: "hms",
    ...overrides,
  };
}

async function record(overrides: Record<string, unknown> = {}) {
  const r = await recordDischarge(dischargePayload(overrides));
  if (!r.ok) throw new Error(`discharge failed: ${JSON.stringify(r.errors)}`);
  return r;
}

const discharges = () => pool().query(`SELECT * FROM discharges ORDER BY created_at`).then((r) => r.rows);
const followUps = () => pool().query(`SELECT * FROM follow_ups ORDER BY created_at`).then((r) => r.rows);
const feedbackRows = () => pool().query(`SELECT * FROM feedback ORDER BY created_at`).then((r) => r.rows);
const tokenFor = async (dischargeId: string) =>
  (await pool().query<{ token: string }>(`SELECT token FROM feedback_requests WHERE discharge_id = $1`, [dischargeId])).rows[0]?.token;

beforeEach(async () => {
  await resetData();
  process.env.FEEDBACK_DELAY_HOURS = "0";
  process.env.PUBLIC_BASE_URL = "https://care.example.com";
  resetEnvCache();
});

afterEach(() => {
  delete process.env.FEEDBACK_DELAY_HOURS;
  delete process.env.PUBLIC_BASE_URL;
  resetEnvCache();
});

describe("Demo 3: discharge follow-up", () => {
  it("relays the approved follow-up, opens a task and schedules reminder + feedback", async () => {
    const r = await record();
    await drain();

    const [d] = await discharges();
    expect(d).toMatchObject({ status: "scheduled", approved_by: "Dr. Ananya Rao", source: "hms" });

    const tasks = await followUps();
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ category: "post_discharge", owner: "department_owner", status: "open" });
    expect(tasks[0]!.approved_date).toBe(dischargePayload().approved_followup_date);

    const msgs = await q.messages();
    const followUpMsg = msgs.find((m) => m.template_name === "DISCHARGE_FOLLOWUP_01")!;
    expect(followUpMsg.delivery_status).toBe("sent");
    expect(followUpMsg.body).toMatch(/follow-up visit on \w{3}, \d+ \w{3} \d{4} \(Morning OPD\)/);
    // Never invents clinical content.
    expect(followUpMsg.body).not.toMatch(/medicine|dose|tablet|diagnos/i);

    const reminder = (await q.jobs("discharge.reminder"))[0]!;
    expect(reminder.status).toBe("queued");
    // Reminder is the day before the approved date, not on it.
    expect(new Date(reminder.run_at).getTime()).toBeLessThan(new Date(`${dischargePayload().approved_followup_date}T00:00:00+05:30`).getTime());

    expect(await q.auditActions(r.correlationId)).toEqual(
      expect.arrayContaining(["discharge.recorded", "discharge.followup_scheduled", "message.sent"]),
    );
  });

  it("never invents a date: missing approval goes to the department", async () => {
    await record({ approved_followup_date: null, approved_by: null });
    await drain();

    expect((await discharges())[0]).toMatchObject({ status: "needs_review" });
    const exc = (await q.exceptions()).filter((e) => e.error_type === "DISCHARGE_FOLLOWUP_DATE_MISSING");
    expect(exc).toHaveLength(1);
    expect(exc[0]).toMatchObject({ owner: "department_owner", severity: "medium" });

    // No follow-up promise is sent to the patient...
    expect((await q.messages()).some((m) => m.template_name === "DISCHARGE_FOLLOWUP_01")).toBe(false);
    // ...but feedback is still requested, since that needs no clinical approval.
    expect((await q.messages()).some((m) => m.template_name === "FEEDBACK_REQUEST_01")).toBe(true);
    expect(await followUps()).toHaveLength(0);
  });

  it("rejects a date with no named approver and a date before discharge", async () => {
    const noApprover = await recordDischarge(dischargePayload({ approved_by: "" }));
    expect(noApprover.ok).toBe(false);
    if (!noApprover.ok) expect(Object.keys(noApprover.errors)).toContain("approved_by");

    const past = await recordDischarge(dischargePayload({ approved_followup_date: addDays(istDateString(), -1) }));
    expect(past.ok).toBe(false);
    if (!past.ok) expect(Object.keys(past.errors)).toContain("approved_followup_date");
  });

  it("is idempotent per encounter", async () => {
    const a = await record();
    const b = await record();
    expect(b).toMatchObject({ dischargeId: a.dischargeId, duplicate: true });
    expect(await discharges()).toHaveLength(1);

    await drain();
    expect((await q.messages()).filter((m) => m.template_name === "DISCHARGE_FOLLOWUP_01")).toHaveLength(1);
  });

  it("skips the reminder when the follow-up was closed or the date changed", async () => {
    const r = await record();
    await drain();
    const date = dischargePayload().approved_followup_date as string;

    await sendDischargeReminder(r.dischargeId, "2030-01-01"); // date no longer matches
    await pool().query(`UPDATE follow_ups SET status = 'done' WHERE discharge_id = $1`, [r.dischargeId]);
    await sendDischargeReminder(r.dischargeId, date);

    expect((await q.messages()).some((m) => m.template_name === "FOLLOWUP_REMINDER_01")).toBe(false);
    const skipped = await pool().query(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'discharge.reminder_skipped'`);
    expect(skipped.rows[0].n).toBe(2);
  });

  it("sends the reminder once when still due", async () => {
    const r = await record();
    await drain();
    const date = dischargePayload().approved_followup_date as string;
    await sendDischargeReminder(r.dischargeId, date);
    await sendDischargeReminder(r.dischargeId, date);
    expect((await q.messages()).filter((m) => m.template_name === "FOLLOWUP_REMINDER_01")).toHaveLength(1);
  });
});

describe("feedback", () => {
  it("sends a one-time link and records a happy rating", async () => {
    const r = await record();
    await drain();

    const msg = (await q.messages()).find((m) => m.template_name === "FEEDBACK_REQUEST_01")!;
    const token = (await tokenFor(r.dischargeId))!;
    expect(msg.body).toContain(`https://care.example.com/r/${token}`);

    expect(await submitFeedback(token, 5, "Staff were very helpful")).toBe("recorded");
    const [fb] = await feedbackRows();
    expect(fb).toMatchObject({ rating: 5, comment: "Staff were very helpful", discharge_id: r.dischargeId });

    // A good rating creates no exception and no service-recovery task.
    expect((await q.exceptions()).filter((e) => e.error_type === "NEGATIVE_FEEDBACK")).toHaveLength(0);
    expect((await followUps()).filter((f) => f.category === "service_recovery")).toHaveLength(0);
  });

  it("routes an unhappy rating to service recovery", async () => {
    const r = await record();
    await drain();
    const token = (await tokenFor(r.dischargeId))!;

    expect(await submitFeedback(token, 2, "Waited three hours")).toBe("recorded");
    const exc = (await q.exceptions()).filter((e) => e.error_type === "NEGATIVE_FEEDBACK");
    expect(exc).toHaveLength(1);
    expect(exc[0]).toMatchObject({ severity: "high", owner: "service_recovery" });
    expect(exc[0]!.details).toMatchObject({ rating: 2, comment: "Waited three hours" });

    const recovery = (await followUps()).filter((f) => f.category === "service_recovery");
    expect(recovery).toHaveLength(1);
    expect(recovery[0]).toMatchObject({ owner: "service_recovery", status: "open" });
  });

  it("treats 3 stars as service recovery at medium severity", async () => {
    const r = await record();
    await drain();
    const token = (await tokenFor(r.dischargeId))!;
    await submitFeedback(token, 3, null);
    expect((await q.exceptions()).filter((e) => e.error_type === "NEGATIVE_FEEDBACK")[0]).toMatchObject({ severity: "medium" });
  });

  it("accepts a response only once", async () => {
    const r = await record();
    await drain();
    const token = (await tokenFor(r.dischargeId))!;
    expect(await submitFeedback(token, 5, null)).toBe("recorded");
    expect(await submitFeedback(token, 1, "changed my mind")).toBe("already_submitted");
    expect(await feedbackRows()).toHaveLength(1);
  });

  it("rejects unknown and expired links", async () => {
    expect(await submitFeedback("not-a-real-token", 5, null)).toBe("unknown_token");

    const r = await record();
    await drain();
    const token = (await tokenFor(r.dischargeId))!;
    await pool().query(`UPDATE feedback_requests SET expires_at = now() - interval '1 day' WHERE token = $1`, [token]);
    expect(await submitFeedback(token, 5, null)).toBe("expired");
    expect(await feedbackRows()).toHaveLength(0);

    const target = await getFeedbackRequest(token);
    expect(target).toMatchObject({ expired: true, patient_name: "Sunita Deshmukh" });
  });

  it("rejects out-of-range ratings", async () => {
    const r = await record();
    await drain();
    const token = (await tokenFor(r.dischargeId))!;
    await expect(submitFeedback(token, 6, null)).rejects.toThrow();
    await expect(submitFeedback(token, 0, null)).rejects.toThrow();
  });

  it("reuses the same link if the request job runs twice", async () => {
    const r = await record();
    await drain();
    const token = (await tokenFor(r.dischargeId))!;
    await requestFeedback(r.dischargeId);
    expect(await tokenFor(r.dischargeId)).toBe(token);
    expect((await q.messages()).filter((m) => m.template_name === "FEEDBACK_REQUEST_01")).toHaveLength(1);
  });

  it("reports satisfaction stats", async () => {
    const { getFeedbackStats } = await import("@/server/queries");
    const a = await record();
    const b = await record({ phone: "9876500022", encounter_id: "IP-2026-0913", full_name: "Ramesh Gupta" });
    await drain();
    await submitFeedback((await tokenFor(a.dischargeId))!, 5, null);
    await submitFeedback((await tokenFor(b.dischargeId))!, 2, "poor experience");

    const stats = await getFeedbackStats();
    expect(stats).toMatchObject({ responses: 2, requests_sent: 2, average_rating: 3.5, promoters: 1, detractors: 1, service_recovery_open: 1 });
  });
});

describe("department mapping", () => {
  it("maps a reported department name to a configured department", async () => {
    const r = await record({ department: "cardiology" });
    const [d] = await discharges();
    expect(d.department_id).toBe("cardiology");
    expect(r.duplicate).toBe(false);
  });

  it("refuses an unknown department instead of guessing", async () => {
    const r = await recordDischarge(dischargePayload({ department: "Neurosurgery", encounter_id: "IP-X" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.department).toContain("Unknown department");
  });
});
