import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pool } from "@/lib/db";
import { resetEnvCache } from "@/lib/env";
import { istAt, istDateString } from "@/lib/time";
import { intakeLead } from "@/server/workflows/lead-intake";
import { closeFollowUp, escalateNoShow, markAttendance, recoverNoShow, sweepNoShows } from "@/server/workflows/no-show";
import { drain } from "@/worker/runner";
import { addSlot, futureDate, leadPayload, q, resetData } from "./helpers";

async function bookedAppointment(overrides: Record<string, unknown> = {}) {
  const date = futureDate(3);
  await addSlot("DOC-DER-1", date, 10);
  const r = await intakeLead(leadPayload({ preferred_date: date, ...overrides }));
  if (!r.ok) throw new Error("intake failed");
  await drain();
  const appt = (await q.appointments())[0]!;
  return { appt, leadId: r.leadId };
}

const followUps = () => q.jobs().then(() => pool().query(`SELECT * FROM follow_ups ORDER BY created_at`).then((r) => r.rows));
const recoveryMessages = async () => (await q.messages()).filter((m) => m.template_name.startsWith("NOSHOW"));

beforeEach(async () => {
  await resetData();
  process.env.NO_SHOW_RECOVERY_DELAY_MINUTES = "0";
  process.env.NO_SHOW_MAX_ATTEMPTS = "2";
  process.env.NO_SHOW_AUTO_DETECT = "true";
  process.env.NO_SHOW_GRACE_MINUTES = "60";
  resetEnvCache();
});

afterEach(() => {
  delete process.env.NO_SHOW_RECOVERY_DELAY_MINUTES;
  resetEnvCache();
});

describe("Demo 2: no-show recovery", () => {
  it("marking a no-show sends a reschedule message and opens a reception task", async () => {
    const { appt, leadId } = await bookedAppointment();
    // A later slot exists to offer as an alternative.
    await addSlot("DOC-DER-1", futureDate(5), 11);

    const r = await markAttendance(appt.appointment_id, "no_show", "staff");
    expect(r.changed).toBe(true);
    await drain();

    const msgs = await recoveryMessages();
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ template_name: "NOSHOW_RECOVERY_01", delivery_status: "sent" });
    expect(msgs[0]!.body).toContain("Dr. Priya Nair");
    expect(msgs[0]!.body).toMatch(/Next available: \w{3}, \d+ \w{3}/);

    const tasks = await followUps();
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ category: "no_show_recovery", status: "open", attempt_count: 1, owner: "front_desk" });

    const lead = await q.lead(leadId);
    const actions = await q.auditActions(lead!.correlation_id);
    expect(actions).toContain("attendance.marked");
    expect(actions).toContain("noshow.recovery_started");

    // A second escalation attempt is scheduled, not sent yet.
    const escalations = await q.jobs("noshow.escalate");
    expect(escalations).toHaveLength(1);
    expect(escalations[0]).toMatchObject({ status: "queued" });
    expect(new Date(escalations[0]!.run_at).getTime()).toBeGreaterThan(Date.now() + 23 * 3600_000);
  });

  it("cancels pending reminders when the visit is missed", async () => {
    const { appt } = await bookedAppointment();
    expect((await q.jobs("appointment.reminder")).every((j) => j.status === "queued")).toBe(true);

    await markAttendance(appt.appointment_id, "no_show", "staff");
    const reminders = await q.jobs("appointment.reminder");
    expect(reminders.every((j) => j.status === "cancelled")).toBe(true);
  });

  it("does nothing when the patient attended", async () => {
    const { appt } = await bookedAppointment();
    await markAttendance(appt.appointment_id, "attended", "staff");
    await drain();
    expect(await recoveryMessages()).toHaveLength(0);
    expect(await followUps()).toHaveLength(0);
  });

  it("stops the chase if staff correct the attendance before it runs", async () => {
    const { appt } = await bookedAppointment();
    await markAttendance(appt.appointment_id, "no_show", "staff");
    await markAttendance(appt.appointment_id, "attended", "staff"); // patient actually came, marked late
    await drain();

    expect(await recoveryMessages()).toHaveLength(0);
    expect((await q.jobs("noshow.recover"))[0]).toMatchObject({ status: "cancelled" });
  });

  it("recovery runs at most once per appointment", async () => {
    const { appt } = await bookedAppointment();
    await markAttendance(appt.appointment_id, "no_show", "staff");
    await drain();
    await recoverNoShow(appt.appointment_id);
    await recoverNoShow(appt.appointment_id);
    expect(await recoveryMessages()).toHaveLength(1);
    expect(await followUps()).toHaveLength(1);
  });

  it("skips recovery when the patient has already rebooked", async () => {
    // Recovery waits 30 minutes in production; the patient rebooks inside that window.
    process.env.NO_SHOW_RECOVERY_DELAY_MINUTES = "30";
    resetEnvCache();
    const { appt } = await bookedAppointment();
    await markAttendance(appt.appointment_id, "no_show", "staff");

    const date = futureDate(6);
    await addSlot("DOC-DER-2", date, 10);
    const again = await intakeLead(leadPayload({ preferred_date: date, enquiry_text: "please book me again for acne" }));
    expect(again.ok).toBe(true);
    await drain();
    expect(await q.appointments()).toHaveLength(2);

    // The delayed recovery job now fires.
    await recoverNoShow(appt.appointment_id);

    expect(await recoveryMessages()).toHaveLength(0);
    const skipped = await pool().query(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'noshow.recovery_skipped'`);
    expect(skipped.rows[0].n).toBe(1);
  });
});

describe("no-show escalation", () => {
  async function missed() {
    const { appt } = await bookedAppointment();
    await markAttendance(appt.appointment_id, "no_show", "staff");
    await drain();
    return appt;
  }

  it("sends a second message, then hands the patient to reception", async () => {
    const appt = await missed();

    await escalateNoShow(appt.appointment_id, 1);
    const afterFirst = await recoveryMessages();
    expect(afterFirst.map((m) => m.template_name)).toEqual(["NOSHOW_RECOVERY_01", "NOSHOW_FOLLOWUP_02"]);
    expect((await followUps())[0]).toMatchObject({ attempt_count: 2, status: "open" });

    await escalateNoShow(appt.appointment_id, 2);
    expect(await recoveryMessages()).toHaveLength(2); // no third message
    const exc = (await q.exceptions()).filter((e) => e.error_type === "NO_SHOW_UNRESPONSIVE");
    expect(exc).toHaveLength(1);
    expect(exc[0]).toMatchObject({ severity: "medium", owner: "front_desk", status: "open" });
    expect((await followUps())[0]!.status).toBe("open"); // stays open until a person closes it
  });

  it("closes the loop when the patient rebooks", async () => {
    const appt = await missed();
    const date = futureDate(7);
    await addSlot("DOC-DER-2", date, 12);
    await intakeLead(leadPayload({ preferred_date: date, enquiry_text: "rebooking my skin appointment" }));
    await drain();

    await escalateNoShow(appt.appointment_id, 1);
    expect((await followUps())[0]).toMatchObject({ status: "done" });
    expect(await recoveryMessages()).toHaveLength(1); // no chasing message after recovery
    const recovered = await pool().query(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'noshow.recovered'`);
    expect(recovered.rows[0].n).toBe(1);
  });

  it("staff can close a follow-up by hand", async () => {
    const appt = await missed();
    const task = (await followUps())[0]!;
    expect(await closeFollowUp(task.followup_id, "done", "Called patient, booked for Friday")).toBe(true);
    expect(await closeFollowUp(task.followup_id, "done", "again")).toBe(false); // already closed

    await escalateNoShow(appt.appointment_id, 1);
    expect(await recoveryMessages()).toHaveLength(1); // closed task stops the chase
  });
});

describe("automatic no-show detection", () => {
  async function pastAppointment(minutesAgo: number) {
    const { appt } = await bookedAppointment();
    const end = new Date(Date.now() - minutesAgo * 60_000);
    await pool().query(`UPDATE appointments SET slot_start = $2, slot_end = $3 WHERE appointment_id = $1`, [
      appt.appointment_id,
      new Date(end.getTime() - 30 * 60_000),
      end,
    ]);
    return appt;
  }

  it("marks visits missed once the grace period passes", async () => {
    const appt = await pastAppointment(90);
    expect(await sweepNoShows()).toEqual([appt.appointment_id]);
    expect((await q.appointments())[0]).toMatchObject({ attendance_status: "no_show", attendance_marked_by: "system" });
    await drain();
    expect(await recoveryMessages()).toHaveLength(1);
  });

  it("leaves recent and already-marked appointments alone", async () => {
    await pastAppointment(10); // inside the 60 minute grace period
    expect(await sweepNoShows()).toEqual([]);

    const appt = await pastAppointment(120);
    await markAttendance(appt.appointment_id, "attended", "staff");
    expect(await sweepNoShows()).toEqual([]);
  });

  it("can be switched off for hospitals whose HMS reports attendance", async () => {
    process.env.NO_SHOW_AUTO_DETECT = "false";
    resetEnvCache();
    await pastAppointment(180);
    expect(await sweepNoShows()).toEqual([]);
  });

  it("only one worker sweeps at a time", async () => {
    const appt = await pastAppointment(120);
    const { sweepOnce } = await import("@/worker/runner");
    const results = await Promise.all([sweepOnce(), sweepOnce(), sweepOnce()]);
    expect(results.flat()).toEqual([appt.appointment_id]);
  });
});

describe("no-show reporting", () => {
  it("counts no-shows, recoveries and the rate", async () => {
    const { getNoShowStats } = await import("@/server/queries");
    const date = istDateString();
    await addSlot("DOC-GEN-1", date, 9);

    const { appt } = await bookedAppointment();
    await markAttendance(appt.appointment_id, "no_show", "staff");
    await drain();

    let stats = await getNoShowStats();
    expect(stats).toMatchObject({ no_shows_7d: 1, recovered_7d: 0, recovery_open: 1, no_show_rate_7d: 100 });

    const task = (await followUps())[0]!;
    await closeFollowUp(task.followup_id, "done", "rebooked");
    stats = await getNoShowStats();
    expect(stats).toMatchObject({ recovered_7d: 1, recovery_open: 0 });
  });
});

describe("reschedule options", () => {
  it("never offers a time at or before the missed appointment", async () => {
    const { nextOpenSlots } = await import("@/server/workflows/no-show");
    const date = futureDate(4);
    await addSlot("DOC-CAR-1", date, 10);
    await addSlot("DOC-CAR-1", date, 15);
    const missedAt = istAt(date, 12);
    const slots = await nextOpenSlots(pool(), "cardiology", missedAt);
    expect(slots.every((s) => s.getTime() > missedAt.getTime())).toBe(true);
    expect(slots).toHaveLength(1);
  });
});
