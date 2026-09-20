import { beforeEach, describe, expect, it } from "vitest";
import {
  AuditInputsSchema,
  AuditScoresSchema,
  assessReadiness,
  buildReport,
  createAudit,
  deleteAudit,
  estimateLeakage,
  formatRupees,
  getAudit,
  listAudits,
  rankOpportunities,
  saveAudit,
  SCORE_DIMENSIONS,
} from "@/server/audit";
import { pool } from "@/lib/db";
import { resetData } from "./helpers";

const inputs = (o: Record<string, unknown> = {}) =>
  AuditInputsSchema.parse({
    monthly_enquiries: 300,
    enquiries_unanswered_pct: 20,
    typical_first_response_hours: 6,
    monthly_appointments: 200,
    no_show_pct: 15,
    monthly_discharges: 40,
    followup_missed_pct: 50,
    avg_revenue_per_visit: 1500,
    ...o,
  });

const scores = (o: Partial<Record<string, number>> = {}) =>
  AuditScoresSchema.parse(Object.fromEntries(SCORE_DIMENSIONS.map((d) => [d.key, o[d.key] ?? 3])));

beforeEach(async () => {
  await resetData();
  await pool().query(`TRUNCATE audits CASCADE`);
});

describe("leakage estimate", () => {
  it("computes each line from the hospital's own numbers", () => {
    const l = estimateLeakage(inputs());

    // 300 enquiries × 20% unanswered = 60; 25% would have booked = 15 patients × ₹1500.
    expect(l.lines[0]).toMatchObject({ key: "enquiries", missed_patients_per_month: 15, monthly_value: 22500 });
    // 200 appointments × 15% = 30 no-shows; 30% recoverable = 9 × ₹1500.
    expect(l.lines[1]).toMatchObject({ key: "no_shows", missed_patients_per_month: 9, monthly_value: 13500 });
    // 40 discharges × 50% missed = 20; 20% recoverable = 4 × ₹1500.
    expect(l.lines[2]).toMatchObject({ key: "follow_ups", missed_patients_per_month: 4, monthly_value: 6000 });

    expect(l.monthly_total).toBe(42000);
    expect(l.annual_total).toBe(504000);
  });

  it("shows its arithmetic in words", () => {
    const l = estimateLeakage(inputs());
    expect(l.lines[0]!.workings).toBe("300 enquiries × 20% unanswered = 60 people; 25% of them would have booked");
  });

  it("is zero when nothing has been recorded", () => {
    const l = estimateLeakage(AuditInputsSchema.parse({}));
    expect(l.monthly_total).toBe(0);
    expect(l.lines).toHaveLength(3);
  });

  it("follows the assumptions when they are lowered", () => {
    const conservative = estimateLeakage(inputs({ assumed_enquiry_conversion_pct: 10, assumed_noshow_recovery_pct: 10, assumed_followup_recovery_pct: 10 }));
    expect(conservative.monthly_total).toBeLessThan(estimateLeakage(inputs()).monthly_total);
    expect(conservative.lines[0]!.monthly_value).toBe(9000); // 60 × 10% × ₹1500
  });

  it("never returns a negative or fractional rupee figure", () => {
    const l = estimateLeakage(inputs({ monthly_enquiries: 37, enquiries_unanswered_pct: 13, avg_revenue_per_visit: 999 }));
    for (const line of l.lines) {
      expect(line.monthly_value).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(line.monthly_value)).toBe(true);
    }
  });
});

describe("opportunity ranking", () => {
  it("puts the biggest leak first", () => {
    const ranked = rankOpportunities(inputs(), scores());
    expect(ranked[0]!.key).toBe("lead_to_appointment");
    expect(ranked.map((o) => o.key)).toHaveLength(4);
  });

  it("follows the money when no-shows dominate", () => {
    const ranked = rankOpportunities(
      inputs({ enquiries_unanswered_pct: 2, monthly_appointments: 600, no_show_pct: 35 }),
      scores(),
    );
    expect(ranked[0]!.key).toBe("no_show_recovery");
  });

  it("weighs the process gap, not just the money", () => {
    const withGoodProcess = rankOpportunities(inputs(), scores({ lead_response_time: 5, lead_capture_consistency: 5, appointment_conversion_visibility: 5 }));
    const withBadProcess = rankOpportunities(inputs(), scores({ lead_response_time: 1, lead_capture_consistency: 1, appointment_conversion_visibility: 1 }));
    const good = withGoodProcess.find((o) => o.key === "lead_to_appointment")!;
    const bad = withBadProcess.find((o) => o.key === "lead_to_appointment")!;
    expect(bad.priority).toBeGreaterThan(good.priority);
  });

  it("rates everything lower when integration is not feasible", () => {
    const ready = rankOpportunities(inputs(), scores({ integration_readiness: 5, security_governance: 5 }));
    const blocked = rankOpportunities(inputs(), scores({ integration_readiness: 1, security_governance: 1 }));
    expect(blocked[0]!.priority).toBeLessThan(ready[0]!.priority);
  });

  it("still recommends reporting when nothing is measured and there is no rupee figure", () => {
    const ranked = rankOpportunities(AuditInputsSchema.parse({}), scores({ reporting_automation: 1 }));
    expect(ranked[0]!.key).toBe("management_reporting");
  });
});

describe("readiness", () => {
  it("averages the scorecard and names the weakest areas", () => {
    const r = assessReadiness(scores({ no_show_recovery: 1, follow_up_tracking: 1, reporting_automation: 2 }));
    // 8 dimensions at 3, plus 1, 1 and 2 => 28/11 = 2.5 (rounded to one decimal).
    expect(r.average).toBe(2.5);
    expect(r.weakest.map((w) => w.key)).toContain("no_show_recovery");
    expect(r.weakest).toHaveLength(3);
  });

  it("flags integration and governance blockers", () => {
    const r = assessReadiness(scores({ integration_readiness: 1, security_governance: 2 }));
    expect(r.integration_ready).toBe(false);
    expect(r.blockers).toHaveLength(2);
    expect(r.blockers[0]).toContain("HMS/EMR API access");
  });

  it("raises no blockers for a ready hospital", () => {
    expect(assessReadiness(scores({ integration_readiness: 4, security_governance: 4 })).blockers).toHaveLength(0);
  });
});

describe("audit records", () => {
  async function seedAudit() {
    const id = await createAudit({ hospital_name: "Sunrise Multispeciality", city: "Hyderabad", contact_name: "Dr. Ramesh", contact_role: "MD", conducted_by: "Yashwanth" });
    await saveAudit(id, { inputs: inputs(), scores: scores({ no_show_recovery: 1, integration_readiness: 4, security_governance: 4 }) });
    return id;
  }

  it("creates with safe defaults and round-trips edits", async () => {
    const id = await createAudit({ hospital_name: "City Care" });
    const fresh = (await getAudit(id))!;
    expect(fresh).toMatchObject({ hospital_name: "City Care", status: "draft" });
    expect(fresh.inputs.assumed_enquiry_conversion_pct).toBe(25);
    expect(fresh.scores.lead_response_time).toBe(3);

    await saveAudit(id, { inputs: inputs({ monthly_enquiries: 500 }), notes: { current_journey: "Reception writes enquiries in a register.", systems_in_use: "Insta HMS", manual_steps: "", constraints: "" }, status: "final" });
    const saved = (await getAudit(id))!;
    expect(saved.inputs.monthly_enquiries).toBe(500);
    expect(saved.notes.current_journey).toContain("register");
    expect(saved.status).toBe("final");
  });

  it("builds a report that recommends a pilot with a price", async () => {
    const report = buildReport((await getAudit(await seedAudit()))!);
    expect(report.leakage.monthly_total).toBe(42000);
    // Enquiries leak slightly more money, but this hospital scored 1/5 on no-show recovery,
    // so the process gap wins: that is the point of ranking by impact AND gap.
    expect(report.recommended.key).toBe("no_show_recovery");
    expect(report.opportunities[1]!.key).toBe("lead_to_appointment");
    expect(report.pilot.price).toBe(50000);
    expect(report.pilot.package).toBe("Starter");
    expect(report.pilot.kpi).toContain("Recovered appointments");
  });

  it("proposes the broader package when the hospital is weak everywhere but integrable", async () => {
    const id = await createAudit({ hospital_name: "Weak Everywhere" });
    await saveAudit(id, {
      inputs: inputs(),
      scores: scores(Object.fromEntries(SCORE_DIMENSIONS.map((d) => [d.key, 1])) as Record<string, number>),
    });
    await saveAudit(id, { scores: scores({ ...Object.fromEntries(SCORE_DIMENSIONS.map((d) => [d.key, 1])), integration_readiness: 4, security_governance: 4 }) });
    const report = buildReport((await getAudit(id))!);
    expect(report.pilot.package).toBe("Growth");
    expect(report.pilot.price).toBe(100000);
  });

  it("lists and deletes audits", async () => {
    const id = await seedAudit();
    expect((await listAudits()).map((a) => a.audit_id)).toContain(id);
    expect(await deleteAudit(id)).toBe(true);
    expect(await getAudit(id)).toBeUndefined();
    expect(await deleteAudit(id)).toBe(false);
  });

  it("rejects out-of-range numbers and scores", () => {
    expect(() => AuditInputsSchema.parse({ no_show_pct: 150 })).toThrow();
    expect(() => AuditScoresSchema.parse({ ...scores(), lead_response_time: 9 })).toThrow();
  });
});

describe("rupee formatting", () => {
  it("uses the Indian grouping system", () => {
    expect(formatRupees(504000)).toBe("₹5,04,000");
    expect(formatRupees(1500)).toBe("₹1,500");
    expect(formatRupees(12345678)).toBe("₹1,23,45,678");
  });
});
