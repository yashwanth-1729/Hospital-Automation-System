import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { env } from "@/lib/env";
import { formatDateOnly } from "@/lib/time";
import { buildReport, formatRupees, getAudit, SCORE_DIMENSIONS } from "@/server/audit";
import { requireStaff } from "@/server/auth/guard";

export const metadata = { title: "Audit report" };

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="break-inside-avoid border-t border-border pt-6">
      <h2 className="mb-3 text-sm font-semibold tracking-wide text-primary uppercase">{title}</h2>
      {children}
    </section>
  );
}

export default async function AuditReportPage({ params }: { params: Promise<{ id: string }> }) {
  await connection();
  await requireStaff("audits.manage");
  const { id } = await params;
  const audit = await getAudit(id);
  if (!audit) notFound();

  const { leakage, opportunities, readiness, recommended, pilot } = buildReport(audit);
  const i = audit.inputs;
  const e = env();
  const scored = leakage.monthly_total > 0;

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3 print:hidden">
        <Link href={`/audits/${audit.audit_id}`} className="text-sm text-muted hover:text-text">← Back to the audit</Link>
        <p className="text-xs text-muted">Use your browser's Print → Save as PDF to send this to the hospital.</p>
      </div>

      <article className="space-y-6 rounded-xl border border-border bg-surface p-8 print:border-0 print:p-0">
        <header>
          <p className="text-xs tracking-wide text-muted uppercase">Patient journey automation audit</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">{audit.hospital_name}</h1>
          <p className="mt-1 text-sm text-muted">
            {audit.city ? `${audit.city} · ` : ""}
            {formatDateOnly(audit.conducted_on)}
            {audit.contact_name ? ` · Prepared for ${audit.contact_name}${audit.contact_role ? `, ${audit.contact_role}` : ""}` : ""}
            {audit.conducted_by ? ` · By ${audit.conducted_by}` : ""}
          </p>
        </header>

        {scored ? (
          <p className="rounded-lg bg-primary-soft p-4 text-sm">
            Based on the figures {audit.contact_name ?? "the hospital"} provided, roughly{" "}
            <strong>{formatRupees(leakage.monthly_total)} a month</strong> ({formatRupees(leakage.annual_total)} a year) of
            already-paid-for demand is not converting, mostly through <strong>{recommended.title.toLowerCase()}</strong>.
            We recommend starting there with a single measured pilot.
          </p>
        ) : (
          <p className="rounded-lg bg-warn-soft p-4 text-sm text-warn">
            No figures recorded yet. Fill in the hospital's numbers on the audit page to produce the leakage estimate.
          </p>
        )}

        <Section title="1. Current state">
          <dl className="grid gap-3 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-xs text-muted">Enquiries per month</dt>
              <dd className="num">{i.monthly_enquiries || "—"}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted">Typical first response</dt>
              <dd className="num">{i.typical_first_response_hours ? `${i.typical_first_response_hours} hours` : "—"}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted">Appointments per month</dt>
              <dd className="num">{i.monthly_appointments || "—"}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted">No-show rate</dt>
              <dd className="num">{i.no_show_pct ? `${i.no_show_pct}%` : "—"}</dd>
            </div>
          </dl>
          {audit.notes.current_journey && <p className="mt-3 text-sm whitespace-pre-wrap">{audit.notes.current_journey}</p>}
          {audit.notes.manual_steps && (
            <>
              <h3 className="mt-4 text-sm font-medium">Manual steps today</h3>
              <p className="text-sm whitespace-pre-wrap text-muted">{audit.notes.manual_steps}</p>
            </>
          )}
          {audit.notes.systems_in_use && (
            <p className="mt-3 text-sm text-muted">
              <span className="font-medium text-text">Systems in use: </span>
              {audit.notes.systems_in_use}
            </p>
          )}
        </Section>

        <Section title="2. Where demand is leaking">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted uppercase">
                <th className="py-2">Leak</th>
                <th className="py-2">Patients / month</th>
                <th className="py-2 text-right">Value / month</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {leakage.lines.map((l) => (
                <tr key={l.key}>
                  <td className="py-2">
                    {l.label}
                    <div className="text-xs text-muted">{l.workings}</div>
                  </td>
                  <td className="num py-2">{l.missed_patients_per_month}</td>
                  <td className="num py-2 text-right">{formatRupees(l.monthly_value)}</td>
                </tr>
              ))}
              <tr className="font-semibold">
                <td className="py-2">Total</td>
                <td />
                <td className="num py-2 text-right">{formatRupees(leakage.monthly_total)}</td>
              </tr>
            </tbody>
          </table>
          <p className="mt-3 text-xs text-muted">
            These are estimates, not a guarantee. They use the hospital's own figures and three stated assumptions:{" "}
            {i.assumed_enquiry_conversion_pct}% of unanswered enquiries would have booked, {i.assumed_noshow_recovery_pct}% of
            no-shows are recoverable, and {i.assumed_followup_recovery_pct}% of missed follow-ups are recoverable. The pilot
            measures the real figure against today's baseline.
          </p>
        </Section>

        <Section title="3. Readiness">
          <p className="mb-3 text-sm">
            Average readiness <strong>{readiness.average}/5</strong>. Weakest areas:{" "}
            {readiness.weakest.map((w) => `${w.label} (${w.score})`).join(", ")}.
          </p>
          <div className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
            {SCORE_DIMENSIONS.map((d) => (
              <div key={d.key} className="flex items-center justify-between gap-3 border-b border-border/50 py-1">
                <span className="text-muted">{d.label}</span>
                <span className="num font-medium">{audit.scores[d.key]}/5</span>
              </div>
            ))}
          </div>
          {readiness.blockers.length > 0 && (
            <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-warn">
              {readiness.blockers.map((b) => (
                <li key={b}>{b}</li>
              ))}
            </ul>
          )}
        </Section>

        <Section title="4. Proposed automation, in priority order">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted uppercase">
                <th className="py-2">Workflow</th>
                <th className="py-2 text-right">Value / month</th>
                <th className="py-2 text-right">Priority</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {opportunities.map((o) => (
                <tr key={o.key}>
                  <td className="py-2">
                    <span className="font-medium">{o.title}</span>
                    <div className="text-xs text-muted">{o.workflow}</div>
                    <div className="text-xs text-muted">KPI: {o.kpi}</div>
                  </td>
                  <td className="num py-2 text-right">{o.monthly_value ? formatRupees(o.monthly_value) : "—"}</td>
                  <td className="num py-2 text-right">{o.priority}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-3 text-xs text-muted">
            Priority combines the money at stake, how far the current process is from working, and how feasible integration
            looks — not simply the worst score.
          </p>
        </Section>

        <Section title="5. Recommended pilot and scope">
          <p className="text-sm">
            Start with <strong>{recommended.title}</strong>: {recommended.workflow}.
          </p>
          <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-xs text-muted">Measured by</dt>
              <dd>{pilot.kpi}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted">Scope</dt>
              <dd>
                {pilot.package} implementation — {formatRupees(pilot.price)} plus monthly maintenance
              </dd>
            </div>
          </dl>
          <h3 className="mt-4 text-sm font-medium">Included</h3>
          <ul className="list-disc space-y-1 pl-5 text-sm text-muted">
            <li>Discovery, workflow design and configuration against the hospital's approved systems</li>
            <li>Approved WhatsApp templates, communication log and exception queue</li>
            <li>Staff dashboard, management report and training/handover</li>
            <li>Testing of failure paths before go-live, and a rollback plan</li>
          </ul>
          <h3 className="mt-4 text-sm font-medium">Not included</h3>
          <ul className="list-disc space-y-1 pl-5 text-sm text-muted">
            <li>Any clinical decision-making, triage or medical advice — all clinical content goes to hospital staff</li>
            <li>Replacing or modifying the HMS/EMR, and any vendor charges for API access</li>
            <li>WhatsApp conversation charges billed by the provider</li>
          </ul>
          <h3 className="mt-4 text-sm font-medium">What the hospital provides</h3>
          <ul className="list-disc space-y-1 pl-5 text-sm text-muted">
            <li>A named owner, a technical contact and an exception owner</li>
            <li>HMS/EMR vendor contact and API or export documentation with test credentials</li>
            <li>Approval of message templates and the data-handling approach by whoever owns privacy and IT</li>
          </ul>
          {audit.notes.constraints && <p className="mt-3 text-sm whitespace-pre-wrap text-muted">{audit.notes.constraints}</p>}
        </Section>

        <footer className="border-t border-border pt-4 text-xs text-muted">
          Prepared by {audit.conducted_by ?? e.HOSPITAL_NAME}. This audit is an operational assessment, not legal, medical or
          security advice. Figures are estimates based on information supplied by the hospital.
        </footer>
      </article>
    </div>
  );
}
