import Link from "next/link";
import { connection } from "next/server";
import { Badge, Card, Empty, PageHeader, Stat, Td, Th } from "@/components/ui";
import { pool } from "@/lib/db";
import { can } from "@/lib/rbac";
import { formatDateOnly, formatDateTime } from "@/lib/time";
import { requireStaff } from "@/server/auth/guard";
import { CONDITIONS, careStats, dueLabel, isCondition, listCarePlans, type CareView } from "@/server/care/care";
import { planStatusAction, remindNowAction } from "./actions";

export const metadata = { title: "Chronic care" };

const VIEWS: { key: CareView; label: string }[] = [
  { key: "due", label: "Due now" },
  { key: "overdue", label: "Overdue" },
  { key: "all", label: "All enrolled" },
  { key: "paused", label: "Paused" },
];

const TONE = { diabetes: "info", hypertension: "warn", thyroid: "neutral" } as const;

export default async function CarePage({ searchParams }: { searchParams: Promise<{ view?: string; c?: string; q?: string }> }) {
  await connection();
  const user = await requireStaff("care.view");
  const sp = await searchParams;
  const view = VIEWS.find((v) => v.key === sp.view)?.key ?? "due";
  const condition = sp.c && isCondition(sp.c) ? sp.c : undefined;
  const [stats, plans] = await Promise.all([careStats(pool()), listCarePlans(pool(), view, { condition, q: sp.q })]);
  const manage = can(user.role, "care.manage");
  const href = (o: { view?: string; c?: string | null }) => {
    const p = new URLSearchParams();
    p.set("view", o.view ?? view);
    const c = o.c === null ? undefined : (o.c ?? condition);
    if (c) p.set("c", c);
    return `/care?${p.toString()}`;
  };

  return (
    <>
      <PageHeader
        title="Chronic care"
        description="Patients with diabetes, hypertension or thyroid disease, and when they are due back. Clevo reminds them on WhatsApp before each repeat visit, again if they miss it, and then asks the front desk to call."
      />

      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Enrolled" value={stats.enrolled} tone="ok" hint={`${stats.diabetes} diabetes · ${stats.hypertension} BP · ${stats.thyroid} thyroid`} />
        <Stat label="Due this week" value={stats.due_this_week} hint="reminded automatically" href={href({ view: "due" })} />
        <Stat label="Overdue" value={stats.overdue} tone={stats.overdue ? "warn" : "neutral"} hint="missed their review" href={href({ view: "overdue" })} />
        <Stat label="Reminders sent" value={stats.reminded_30d} hint="last 30 days" />
      </div>

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-1.5">
          {VIEWS.map((v) => (
            <Link
              key={v.key}
              href={href({ view: v.key })}
              className={`rounded-lg border px-3 py-1.5 text-sm transition-colors ${v.key === view ? "border-primary bg-primary-soft text-primary" : "border-border text-muted hover:text-text"}`}
            >
              {v.label}
            </Link>
          ))}
        </div>
        <div className="flex flex-wrap gap-4 text-sm">
          <Link href={href({ c: null })} className={!condition ? "font-medium text-primary" : "text-muted hover:text-text"}>
            All
          </Link>
          {(Object.keys(CONDITIONS) as (keyof typeof CONDITIONS)[]).map((c) => (
            <Link key={c} href={href({ c })} className={condition === c ? "font-medium text-primary" : "text-muted hover:text-text"}>
              {CONDITIONS[c].label}
            </Link>
          ))}
        </div>
      </div>

      <Card>
        {plans.length === 0 ? (
          <Empty>{view === "overdue" ? "Nobody is overdue." : view === "due" ? "Nobody is due in the next two weeks." : "No patients here."}</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="border-b border-border">
                <tr>
                  <Th>Patient</Th>
                  <Th>Condition</Th>
                  <Th>Last visit</Th>
                  <Th>Next review</Th>
                  <Th>WhatsApp</Th>
                  {manage && <Th className="text-right">Action</Th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {plans.map((p) => (
                  <tr key={p.plan_id} className="hover:bg-surface-2">
                    <Td>
                      <Link href={`/patients/${p.patient_id}`} className="font-medium hover:text-primary">
                        {p.patient_name}
                      </Link>
                      <div className="text-xs text-muted">
                        {p.uhid}
                        {p.source === "hms" && " · from HMS"}
                      </div>
                    </Td>
                    <Td>
                      <Badge tone={TONE[p.condition]}>{CONDITIONS[p.condition].label}</Badge>
                      <div className="mt-1 text-xs text-muted">every {p.interval_days} days</div>
                    </Td>
                    <Td className="num text-sm">{formatDateOnly(p.last_visit_date)}</Td>
                    <Td>
                      <div className="num text-sm">{formatDateOnly(p.next_due_date)}</div>
                      <div className={`text-xs ${p.days_to_due < -6 ? "font-medium text-warn" : p.days_to_due <= 3 ? "text-primary" : "text-muted"}`}>
                        {dueLabel(p.days_to_due)}
                      </div>
                    </Td>
                    <Td className="text-sm">
                      {p.reminders_sent === 0 ? (
                        <span className="text-muted">{p.days_to_due <= 3 ? "sending today" : "not yet"}</span>
                      ) : (
                        <>
                          <Badge tone="ok">{p.reminders_sent === 1 ? "Reminded" : "Reminded twice"}</Badge>
                          {p.last_reminded_at && <div className="mt-1 text-xs text-muted">{formatDateTime(p.last_reminded_at)}</div>}
                        </>
                      )}
                    </Td>
                    {manage && (
                      <Td className="text-right">
                        <div className="flex justify-end gap-2">
                          {p.status === "active" ? (
                            <>
                              <form action={remindNowAction}>
                                <input type="hidden" name="plan_id" value={p.plan_id} />
                                <button className="rounded-lg border border-primary px-2.5 py-1 text-xs font-medium text-primary hover:bg-primary-soft">Remind now</button>
                              </form>
                              <form action={planStatusAction}>
                                <input type="hidden" name="plan_id" value={p.plan_id} />
                                <button name="status" value="paused" className="rounded-lg border border-border px-2.5 py-1 text-xs text-muted hover:text-text">
                                  Pause
                                </button>
                              </form>
                            </>
                          ) : (
                            <form action={planStatusAction}>
                              <input type="hidden" name="plan_id" value={p.plan_id} />
                              <button name="status" value="active" className="rounded-lg border border-border px-2.5 py-1 text-xs hover:border-primary hover:text-primary">
                                Resume
                              </button>
                            </form>
                          )}
                        </div>
                      </Td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <p className="mt-4 text-xs text-muted">
        Patients are enrolled automatically when a doctor&apos;s diagnosis names the condition, in Clevo or in your existing HMS. Each visit restarts the clock.
      </p>
    </>
  );
}
