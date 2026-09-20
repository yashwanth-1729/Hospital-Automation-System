import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Card, PageHeader, Stat } from "@/components/ui";
import { buildReport, formatRupees, getAudit, SCORE_DIMENSIONS } from "@/server/audit";
import { deleteAuditAction, saveAuditAction } from "../actions";

export const metadata = { title: "Audit" };

const inputClass = "mt-1 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-primary";

function Num({ name, label, value, hint, suffix }: { name: string; label: string; value: number; hint?: string; suffix?: string }) {
  return (
    <label className="block text-sm font-medium">
      {label}
      <div className="relative">
        <input name={name} type="number" min={0} step="any" defaultValue={value} className={inputClass} />
        {suffix && <span className="absolute top-1/2 right-3 -translate-y-1/2 text-xs text-muted">{suffix}</span>}
      </div>
      {hint && <span className="mt-1 block text-xs text-muted">{hint}</span>}
    </label>
  );
}

function Text({ name, label, value, hint, rows = 3 }: { name: string; label: string; value: string; hint?: string; rows?: number }) {
  return (
    <label className="block text-sm font-medium">
      {label}
      <textarea name={name} rows={rows} defaultValue={value} className={inputClass} />
      {hint && <span className="mt-1 block text-xs text-muted">{hint}</span>}
    </label>
  );
}

export default async function AuditPage({ params }: { params: Promise<{ id: string }> }) {
  await connection();
  const { id } = await params;
  const audit = await getAudit(id);
  if (!audit) notFound();
  const report = buildReport(audit);
  const { inputs, scores, notes } = audit;

  return (
    <>
      <div className="mb-2 text-sm">
        <Link href="/audits" className="text-muted hover:text-text">← Audits</Link>
      </div>
      <PageHeader
        title={audit.hospital_name}
        description="Record what the hospital told you. The leakage, priorities and pilot scope update from these numbers."
        actions={
          <Link href={`/audits/${audit.audit_id}/report`} className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white hover:opacity-90">
            Open report
          </Link>
        }
      />

      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Estimated leakage" value={formatRupees(report.leakage.monthly_total)} hint="per month, from their numbers" tone={report.leakage.monthly_total ? "warn" : "neutral"} />
        <Stat label="Over a year" value={formatRupees(report.leakage.annual_total)} tone="warn" />
        <Stat label="Readiness" value={`${report.readiness.average}/5`} hint="average across 11 dimensions" tone="primary" />
        <Stat label="Suggested pilot" value={report.pilot.package} hint={formatRupees(report.pilot.price)} tone="ok" />
      </div>

      <form action={saveAuditAction} className="space-y-6">
        <input type="hidden" name="audit_id" value={audit.audit_id} />

        <Card title="Hospital and contact">
          <div className="grid gap-4 p-4 sm:grid-cols-3">
            <label className="block text-sm font-medium sm:col-span-2">
              Hospital name
              <input name="hospital_name" defaultValue={audit.hospital_name} className={inputClass} />
            </label>
            <label className="block text-sm font-medium">
              City
              <input name="city" defaultValue={audit.city ?? ""} className={inputClass} />
            </label>
            <label className="block text-sm font-medium">
              Contact person
              <input name="contact_name" defaultValue={audit.contact_name ?? ""} className={inputClass} />
            </label>
            <label className="block text-sm font-medium">
              Their role
              <input name="contact_role" defaultValue={audit.contact_role ?? ""} className={inputClass} />
            </label>
            <label className="block text-sm font-medium">
              Audit by
              <input name="conducted_by" defaultValue={audit.conducted_by ?? ""} className={inputClass} />
            </label>
          </div>
        </Card>

        <Card title="Their numbers">
          <div className="grid gap-4 p-4 sm:grid-cols-2 lg:grid-cols-4">
            <Num name="monthly_enquiries" label="Enquiries per month" value={inputs.monthly_enquiries} hint="all sources combined" />
            <Num name="enquiries_unanswered_pct" label="Never answered, or answered late" value={inputs.enquiries_unanswered_pct} suffix="%" />
            <Num name="typical_first_response_hours" label="Typical first response" value={inputs.typical_first_response_hours} suffix="hrs" />
            <Num name="avg_revenue_per_visit" label="Average value per visit" value={inputs.avg_revenue_per_visit} suffix="₹" hint="consultation plus usual tests" />
            <Num name="monthly_appointments" label="Appointments per month" value={inputs.monthly_appointments} />
            <Num name="no_show_pct" label="No-show rate" value={inputs.no_show_pct} suffix="%" />
            <Num name="monthly_discharges" label="Discharges per month" value={inputs.monthly_discharges} />
            <Num name="followup_missed_pct" label="Follow-ups not completed" value={inputs.followup_missed_pct} suffix="%" />
          </div>
          <div className="border-t border-border p-4">
            <h3 className="text-xs font-medium tracking-wide text-muted uppercase">Assumptions used in the estimate</h3>
            <p className="mt-1 mb-3 text-xs text-muted">
              Printed in the report so nothing looks like a guarantee. Lower them if the hospital pushes back.
            </p>
            <div className="grid gap-4 sm:grid-cols-3">
              <Num name="assumed_enquiry_conversion_pct" label="Unanswered enquiries that would book" value={inputs.assumed_enquiry_conversion_pct} suffix="%" />
              <Num name="assumed_noshow_recovery_pct" label="No-shows recoverable" value={inputs.assumed_noshow_recovery_pct} suffix="%" />
              <Num name="assumed_followup_recovery_pct" label="Missed follow-ups recoverable" value={inputs.assumed_followup_recovery_pct} suffix="%" />
            </div>
          </div>
        </Card>

        <Card title="Readiness scorecard" action={<span className="text-xs text-muted">1 = nothing in place · 5 = working well</span>}>
          <div className="divide-y divide-border">
            {SCORE_DIMENSIONS.map((d) => (
              <div key={d.key} className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5">
                <span className="text-sm">{d.label}</span>
                <div className="flex gap-1">
                  {[1, 2, 3, 4, 5].map((n) => (
                    <label key={n} className="cursor-pointer">
                      <input type="radio" name={d.key} value={n} defaultChecked={scores[d.key] === n} className="peer sr-only" />
                      <span className="grid h-8 w-8 place-items-center rounded-lg border border-border text-sm peer-checked:border-primary peer-checked:bg-primary-soft peer-checked:font-semibold peer-checked:text-primary hover:border-primary/50">
                        {n}
                      </span>
                    </label>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </Card>

        <Card title="What you observed">
          <div className="grid gap-4 p-4 lg:grid-cols-2">
            <Text name="current_journey" label="Current patient journey" value={notes.current_journey} rows={5} hint="enquiry → booking → visit → discharge, in their words" />
            <Text name="manual_steps" label="Manual steps and where things break" value={notes.manual_steps} rows={5} />
            <Text name="systems_in_use" label="Systems in use" value={notes.systems_in_use} hint="HMS/EMR name and vendor, CRM, calendar, WhatsApp provider" />
            <Text name="constraints" label="Constraints and concerns" value={notes.constraints} hint="approvals needed, IT policy, budget cycle" />
          </div>
        </Card>

        <div className="flex flex-wrap items-center gap-3">
          <button name="status" value="draft" className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white hover:opacity-90">
            Save draft
          </button>
          <button name="status" value="final" className="rounded-lg border border-border px-4 py-2 text-sm font-medium hover:border-primary hover:text-primary">
            Save and mark final
          </button>
          <span className="text-xs text-muted">Status: {audit.status}</span>
        </div>
      </form>

      <form action={deleteAuditAction} className="mt-8 border-t border-border pt-4">
        <input type="hidden" name="audit_id" value={audit.audit_id} />
        <button className="text-xs text-muted hover:text-danger">Delete this audit</button>
      </form>
    </>
  );
}
