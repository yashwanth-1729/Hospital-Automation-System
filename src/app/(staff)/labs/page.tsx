import Link from "next/link";
import { connection } from "next/server";
import { AutoRefresh } from "@/components/client";
import { Badge, Card, Empty, PageHeader, Stat, Td, Th } from "@/components/ui";
import { pool } from "@/lib/db";
import { can } from "@/lib/rbac";
import { formatDateTime } from "@/lib/time";
import { requireStaff } from "@/server/auth/guard";
import { labStats, listLabs, REVIEW_WITHIN_HOURS, type LabView } from "@/server/care/labs";
import { readyAction, reviewedAction } from "./actions";

export const metadata = { title: "Lab follow-ups" };

const VIEWS: { key: LabView; label: string }[] = [
  { key: "review", label: "Ready, not reviewed" },
  { key: "waiting", label: "Waiting for results" },
  { key: "done", label: "Reviewed" },
];

const waited = (h: number | null) => (h === null ? "" : h < 1 ? "just now" : h < 48 ? `${h} h` : `${Math.round(h / 24)} days`);

export default async function LabsPage({ searchParams }: { searchParams: Promise<{ view?: string }> }) {
  await connection();
  const user = await requireStaff("care.view");
  const { view: requested } = await searchParams;
  const view = VIEWS.find((v) => v.key === requested)?.key ?? "review";
  const [stats, rows] = await Promise.all([labStats(pool()), listLabs(pool(), view)]);
  const review = can(user.role, "labs.review");
  const manage = can(user.role, "care.manage");

  return (
    <>
      <AutoRefresh seconds={10} />
      <PageHeader
        title="Lab follow-ups"
        description={`When a report is ready, Clevo tells the patient on WhatsApp to come and go through it. Abnormal results go to the doctor at once, and any report not reviewed within ${REVIEW_WITHIN_HOURS} hours is chased.`}
      />

      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Awaiting review" value={stats.awaiting_review} tone={stats.awaiting_review ? "warn" : "neutral"} href="/labs?view=review" />
        <Stat label="Abnormal, open" value={stats.abnormal_open} tone={stats.abnormal_open ? "danger" : "neutral"} hint="sent to the doctor" />
        <Stat label="Patients told" value={stats.patients_told_7d} tone="ok" hint="on WhatsApp, last 7 days" />
        <Stat label="Waiting for results" value={stats.waiting_results} href="/labs?view=waiting" />
      </div>

      <div className="mb-4 flex flex-wrap gap-1.5">
        {VIEWS.map((v) => (
          <Link
            key={v.key}
            href={`/labs?view=${v.key}`}
            className={`rounded-lg border px-3 py-1.5 text-sm transition-colors ${v.key === view ? "border-primary bg-primary-soft text-primary" : "border-border text-muted hover:text-text"}`}
          >
            {v.label}
          </Link>
        ))}
      </div>

      <Card>
        {rows.length === 0 ? (
          <Empty>{view === "review" ? "Every ready report has been reviewed." : view === "waiting" ? "No tests are waiting for results." : "Nothing reviewed yet."}</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="border-b border-border">
                <tr>
                  <Th>Patient</Th>
                  <Th>Test</Th>
                  <Th>{view === "waiting" ? "Ordered" : "Report ready"}</Th>
                  <Th>Patient told</Th>
                  <Th className="text-right">{view === "done" ? "Reviewed" : "Action"}</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {rows.map((r) => {
                  const when = view === "waiting" ? r.ordered_at : r.report_ready_at;
                  return (
                    <tr key={r.diagnostic_id} className="hover:bg-surface-2">
                      <Td>
                        <Link href={`/patients/${r.patient_id}`} className="font-medium hover:text-primary">
                          {r.patient_name}
                        </Link>
                        <div className="text-xs text-muted">
                          {r.uhid}
                          {r.source === "hms" && " · from HMS"}
                        </div>
                      </Td>
                      <Td>
                        <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
                          {r.test}
                          {r.result_flag === "abnormal" && <Badge tone="danger">Abnormal</Badge>}
                        </div>
                        {r.doctor_name && <div className="text-xs text-muted">{r.doctor_name}</div>}
                      </Td>
                      <Td className="text-sm">
                        {when && <div className="num">{formatDateTime(when)}</div>}
                        {view !== "done" && (
                          <div className={`text-xs ${view === "review" && (r.hours_waiting ?? 0) >= REVIEW_WITHIN_HOURS ? "font-medium text-warn" : "text-muted"}`}>
                            waiting {waited(r.hours_waiting)}
                          </div>
                        )}
                      </Td>
                      <Td className="text-sm">
                        {r.notified_at ? (
                          <>
                            <Badge tone="ok">WhatsApp sent</Badge>
                            <div className="mt-1 text-xs text-muted">{formatDateTime(r.notified_at)}</div>
                          </>
                        ) : r.report_ready_at ? (
                          <span className="text-muted">{r.notification_status === "skipped" ? "no WhatsApp consent" : "sending…"}</span>
                        ) : (
                          <span className="text-muted">when ready</span>
                        )}
                      </Td>
                      <Td className="text-right">
                        {view === "review" && review && (
                          <form action={reviewedAction}>
                            <input type="hidden" name="diagnostic_id" value={r.diagnostic_id} />
                            <button className="rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-white hover:opacity-90">Mark reviewed</button>
                          </form>
                        )}
                        {view === "waiting" && manage && (
                          <form action={readyAction} className="flex justify-end gap-2">
                            <input type="hidden" name="diagnostic_id" value={r.diagnostic_id} />
                            <button name="flag" value="normal" className="rounded-lg border border-primary px-2.5 py-1 text-xs font-medium text-primary hover:bg-primary-soft">
                              Report ready
                            </button>
                            <button name="flag" value="abnormal" className="rounded-lg border border-border px-2.5 py-1 text-xs hover:border-danger hover:text-danger">
                              Abnormal
                            </button>
                          </form>
                        )}
                        {view === "done" && (
                          <div className="text-xs text-muted">
                            {r.reviewed_by_name}
                            {r.reviewed_at && <div className="num">{formatDateTime(r.reviewed_at)}</div>}
                          </div>
                        )}
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <p className="mt-4 text-xs text-muted">Reports arrive from your existing lab system or HMS, or staff mark them ready here.</p>
    </>
  );
}
