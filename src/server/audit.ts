import { z } from "zod";
import { many, one, pool } from "@/lib/db";
import { newId } from "@/lib/ids";

/**
 * Hospital automation audit (blueprint sections AB + AC).
 *
 * Every rupee figure here is an ESTIMATE built from numbers the hospital gave us and
 * assumptions printed beside the result. Nothing is a promise, and the report says so.
 */

export const AuditInputsSchema = z.object({
  // What the hospital told us.
  monthly_enquiries: z.coerce.number().min(0).max(100000).default(0),
  enquiries_unanswered_pct: z.coerce.number().min(0).max(100).default(0),
  typical_first_response_hours: z.coerce.number().min(0).max(720).default(0),
  monthly_appointments: z.coerce.number().min(0).max(100000).default(0),
  no_show_pct: z.coerce.number().min(0).max(100).default(0),
  monthly_discharges: z.coerce.number().min(0).max(100000).default(0),
  followup_missed_pct: z.coerce.number().min(0).max(100).default(0),
  avg_revenue_per_visit: z.coerce.number().min(0).max(1000000).default(0),

  // Conservative assumptions, adjustable per hospital and printed in the report.
  assumed_enquiry_conversion_pct: z.coerce.number().min(0).max(100).default(25),
  assumed_noshow_recovery_pct: z.coerce.number().min(0).max(100).default(30),
  assumed_followup_recovery_pct: z.coerce.number().min(0).max(100).default(20),
});
export type AuditInputs = z.infer<typeof AuditInputsSchema>;

/** Blueprint scorecard (section AC): 1 = nothing in place, 5 = working well. */
export const SCORE_DIMENSIONS = [
  { key: "lead_response_time", label: "Lead response time" },
  { key: "lead_capture_consistency", label: "Lead capture consistency" },
  { key: "appointment_conversion_visibility", label: "Appointment conversion visibility" },
  { key: "no_show_recovery", label: "No-show recovery" },
  { key: "follow_up_tracking", label: "Follow-up tracking" },
  { key: "diagnostic_coordination", label: "Diagnostic coordination" },
  { key: "discharge_coordination", label: "Discharge coordination" },
  { key: "feedback_service_recovery", label: "Feedback and service recovery" },
  { key: "reporting_automation", label: "Reporting automation" },
  { key: "integration_readiness", label: "Integration readiness (HMS API)" },
  { key: "security_governance", label: "Security and governance readiness" },
] as const;

export type ScoreKey = (typeof SCORE_DIMENSIONS)[number]["key"];

export const AuditScoresSchema = z.object(
  Object.fromEntries(SCORE_DIMENSIONS.map((d) => [d.key, z.coerce.number().int().min(1).max(5).default(3)])) as Record<
    ScoreKey,
    z.ZodDefault<z.ZodNumber>
  >,
);
export type AuditScores = z.infer<typeof AuditScoresSchema>;

export const AuditNotesSchema = z.object({
  current_journey: z.string().max(4000).default(""),
  systems_in_use: z.string().max(2000).default(""),
  manual_steps: z.string().max(4000).default(""),
  constraints: z.string().max(2000).default(""),
});
export type AuditNotes = z.infer<typeof AuditNotesSchema>;

export interface Audit {
  audit_id: string;
  hospital_name: string;
  city: string | null;
  contact_name: string | null;
  contact_role: string | null;
  conducted_by: string | null;
  conducted_on: string;
  status: "draft" | "final";
  inputs: AuditInputs;
  scores: AuditScores;
  notes: AuditNotes;
  created_at: Date;
  updated_at: Date;
}

export interface LeakageLine {
  key: "enquiries" | "no_shows" | "follow_ups";
  label: string;
  /** Plain-language arithmetic, printed in the report so nothing looks like a black box. */
  workings: string;
  missed_patients_per_month: number;
  monthly_value: number;
}

export interface Leakage {
  lines: LeakageLine[];
  monthly_total: number;
  annual_total: number;
}

const round = (n: number) => Math.round(n);
const pct = (n: number) => n / 100;

/** Leakage estimate from the hospital's own numbers. Conservative by design. */
export function estimateLeakage(i: AuditInputs): Leakage {
  const unansweredEnquiries = i.monthly_enquiries * pct(i.enquiries_unanswered_pct);
  const enquiryPatients = unansweredEnquiries * pct(i.assumed_enquiry_conversion_pct);

  const noShows = i.monthly_appointments * pct(i.no_show_pct);
  const noShowPatients = noShows * pct(i.assumed_noshow_recovery_pct);

  const missedFollowUps = i.monthly_discharges * pct(i.followup_missed_pct);
  const followUpPatients = missedFollowUps * pct(i.assumed_followup_recovery_pct);

  const lines: LeakageLine[] = [
    {
      key: "enquiries",
      label: "Enquiries never answered or answered late",
      workings: `${round(i.monthly_enquiries)} enquiries × ${i.enquiries_unanswered_pct}% unanswered = ${round(unansweredEnquiries)} people; ${i.assumed_enquiry_conversion_pct}% of them would have booked`,
      missed_patients_per_month: round(enquiryPatients),
      monthly_value: round(enquiryPatients * i.avg_revenue_per_visit),
    },
    {
      key: "no_shows",
      label: "No-shows never followed up",
      workings: `${round(i.monthly_appointments)} appointments × ${i.no_show_pct}% no-show = ${round(noShows)} missed visits; ${i.assumed_noshow_recovery_pct}% recoverable with a reschedule offer`,
      missed_patients_per_month: round(noShowPatients),
      monthly_value: round(noShowPatients * i.avg_revenue_per_visit),
    },
    {
      key: "follow_ups",
      label: "Discharged patients who never returned",
      workings: `${round(i.monthly_discharges)} discharges × ${i.followup_missed_pct}% without a completed follow-up = ${round(missedFollowUps)} patients; ${i.assumed_followup_recovery_pct}% recoverable with coordination`,
      missed_patients_per_month: round(followUpPatients),
      monthly_value: round(followUpPatients * i.avg_revenue_per_visit),
    },
  ];

  const monthly_total = lines.reduce((n, l) => n + l.monthly_value, 0);
  return { lines, monthly_total, annual_total: monthly_total * 12 };
}

export interface Opportunity {
  key: string;
  title: string;
  /** What we would build first for this opportunity. */
  workflow: string;
  monthly_value: number;
  /** 0-100. Impact, frequency and feasibility, minus risk (blueprint section AC). */
  priority: number;
  impact_share: number;
  gap: number;
  feasibility: number;
  kpi: string;
}

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

/**
 * Ranks opportunities the way the blueprint insists: not by worst score, but by
 * impact × frequency × feasibility × risk.
 */
export function rankOpportunities(i: AuditInputs, scores: AuditScores): Opportunity[] {
  const leakage = estimateLeakage(i);
  const total = leakage.monthly_total || 1;
  const value = (key: LeakageLine["key"]) => leakage.lines.find((l) => l.key === key)!.monthly_value;

  // Integration readiness and governance gate how quickly anything can ship.
  const feasibility = (scores.integration_readiness + scores.security_governance) / 10;

  const candidates = [
    {
      key: "lead_to_appointment",
      title: "Enquiry to confirmed appointment",
      workflow: "Lead capture → AI qualification → availability → booking → confirmation → reminders",
      monthly_value: value("enquiries"),
      gapScore: (scores.lead_response_time + scores.lead_capture_consistency + scores.appointment_conversion_visibility) / 3,
      kpi: "First response time, and enquiry-to-appointment conversion",
    },
    {
      key: "no_show_recovery",
      title: "No-show recovery",
      workflow: "Missed visit → reschedule offer → reception task → escalation",
      monthly_value: value("no_shows"),
      gapScore: scores.no_show_recovery,
      kpi: "Recovered appointments ÷ eligible no-shows",
    },
    {
      key: "discharge_follow_up",
      title: "Discharge follow-up and feedback",
      workflow: "Discharge → approved follow-up → reminder → feedback → service recovery",
      monthly_value: value("follow_ups"),
      gapScore: (scores.discharge_coordination + scores.follow_up_tracking + scores.feedback_service_recovery) / 3,
      kpi: "Completed follow-ups, and average patient rating",
    },
    {
      key: "management_reporting",
      title: "Management reporting",
      workflow: "Operational dashboard, exception queue and a daily summary",
      monthly_value: 0,
      gapScore: scores.reporting_automation,
      kpi: "Daily report delivered without anyone compiling it",
    },
  ];

  return candidates
    .map((c) => {
      const impact_share = clamp01(c.monthly_value / total);
      const gap = clamp01((5 - c.gapScore) / 4);
      // Reporting has no direct rupee value but is worth doing when nothing is measured.
      const weightedImpact = c.key === "management_reporting" ? gap * 0.35 : impact_share;
      const priority = Math.round((weightedImpact * 0.5 + gap * 0.25 + feasibility * 0.25) * 100);
      return {
        key: c.key,
        title: c.title,
        workflow: c.workflow,
        monthly_value: c.monthly_value,
        priority,
        impact_share: Math.round(impact_share * 100),
        gap: Math.round(gap * 100),
        feasibility: Math.round(feasibility * 100),
        kpi: c.kpi,
      };
    })
    .sort((a, b) => b.priority - a.priority || b.monthly_value - a.monthly_value);
}

export interface Readiness {
  average: number;
  weakest: { key: ScoreKey; label: string; score: number }[];
  integration_ready: boolean;
  /** What must be confirmed before quoting a production integration. */
  blockers: string[];
}

export function assessReadiness(scores: AuditScores): Readiness {
  const entries = SCORE_DIMENSIONS.map((d) => ({ key: d.key, label: d.label, score: scores[d.key] }));
  const average = entries.reduce((n, e) => n + e.score, 0) / entries.length;
  const blockers: string[] = [];
  if (scores.integration_readiness <= 2) blockers.push("HMS/EMR API access is unproven — confirm with the vendor before promising write-back.");
  if (scores.security_governance <= 2) blockers.push("No clear data-handling owner — a privacy/IT approval step must be added to the timeline.");
  return {
    average: Math.round(average * 10) / 10,
    weakest: [...entries].sort((a, b) => a.score - b.score).slice(0, 3),
    integration_ready: scores.integration_readiness >= 3,
    blockers,
  };
}

export interface AuditReport {
  audit: Audit;
  leakage: Leakage;
  opportunities: Opportunity[];
  readiness: Readiness;
  recommended: Opportunity;
  /** Scope proposed for the pilot, based on the recommendation. */
  pilot: { workflow: string; kpi: string; package: "Starter" | "Growth"; price: number };
}

export function buildReport(audit: Audit): AuditReport {
  const leakage = estimateLeakage(audit.inputs);
  const opportunities = rankOpportunities(audit.inputs, audit.scores);
  const readiness = assessReadiness(audit.scores);
  const recommended = opportunities[0]!;
  // A hospital with several weak areas and workable integration is a Growth-scope build.
  const growth = readiness.average < 2.5 && readiness.integration_ready;
  return {
    audit,
    leakage,
    opportunities,
    readiness,
    recommended,
    pilot: {
      workflow: recommended.workflow,
      kpi: recommended.kpi,
      package: growth ? "Growth" : "Starter",
      price: growth ? 100000 : 50000,
    },
  };
}

// --- persistence ---

const parseAudit = (row: Record<string, unknown>): Audit => ({
  ...(row as unknown as Audit),
  inputs: AuditInputsSchema.parse(row.inputs ?? {}),
  scores: AuditScoresSchema.parse(row.scores ?? {}),
  notes: AuditNotesSchema.parse(row.notes ?? {}),
});

export async function createAudit(fields: {
  hospital_name: string;
  city?: string | null;
  contact_name?: string | null;
  contact_role?: string | null;
  conducted_by?: string | null;
}): Promise<string> {
  const id = newId("AUD");
  await pool().query(
    `INSERT INTO audits (audit_id, hospital_name, city, contact_name, contact_role, conducted_by, inputs, scores, notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      id,
      fields.hospital_name,
      fields.city ?? null,
      fields.contact_name ?? null,
      fields.contact_role ?? null,
      fields.conducted_by ?? null,
      AuditInputsSchema.parse({}),
      AuditScoresSchema.parse({}),
      AuditNotesSchema.parse({}),
    ],
  );
  return id;
}

export async function getAudit(auditId: string): Promise<Audit | undefined> {
  const row = await one<Record<string, unknown>>(pool(), `SELECT * FROM audits WHERE audit_id = $1`, [auditId]);
  return row ? parseAudit(row) : undefined;
}

export async function listAudits(): Promise<Audit[]> {
  const rows = await many<Record<string, unknown>>(pool(), `SELECT * FROM audits ORDER BY created_at DESC LIMIT 100`);
  return rows.map(parseAudit);
}

export async function saveAudit(
  auditId: string,
  patch: {
    hospital_name?: string;
    city?: string | null;
    contact_name?: string | null;
    contact_role?: string | null;
    conducted_by?: string | null;
    status?: "draft" | "final";
    inputs?: AuditInputs;
    scores?: AuditScores;
    notes?: AuditNotes;
  },
): Promise<boolean> {
  const r = await pool().query(
    `UPDATE audits SET
       hospital_name = COALESCE($2, hospital_name),
       city = COALESCE($3, city),
       contact_name = COALESCE($4, contact_name),
       contact_role = COALESCE($5, contact_role),
       conducted_by = COALESCE($6, conducted_by),
       status = COALESCE($7, status),
       inputs = COALESCE($8, inputs),
       scores = COALESCE($9, scores),
       notes = COALESCE($10, notes),
       updated_at = now()
     WHERE audit_id = $1`,
    [
      auditId,
      patch.hospital_name ?? null,
      patch.city ?? null,
      patch.contact_name ?? null,
      patch.contact_role ?? null,
      patch.conducted_by ?? null,
      patch.status ?? null,
      patch.inputs ?? null,
      patch.scores ?? null,
      patch.notes ?? null,
    ],
  );
  return (r.rowCount ?? 0) > 0;
}

export async function deleteAudit(auditId: string): Promise<boolean> {
  const r = await pool().query(`DELETE FROM audits WHERE audit_id = $1`, [auditId]);
  return (r.rowCount ?? 0) > 0;
}

/** ₹ formatting in the Indian system (lakh/crore grouping). */
export function formatRupees(n: number): string {
  return `₹${new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(Math.round(n))}`;
}
