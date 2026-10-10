import Link from "next/link";
import { connection } from "next/server";
import { Card, PageHeader, Stat } from "@/components/ui";
import { BarChart, RankedList } from "@/components/charts";
import { pool } from "@/lib/db";
import { formatDateOnly } from "@/lib/time";
import { requireStaff } from "@/server/auth/guard";
import { hospitalAnalytics } from "@/server/clinic/analytics";
import { occupancy } from "@/server/ipd/admissions";
import { stockOverview } from "@/server/pharmacy/stock";
import { inr } from "../billing/status";

export const metadata = { title: "Analytics" };

const RANGES = [7, 14, 30, 90] as const;

const short = (iso: string) => {
  const [, m, d] = iso.split("-");
  return `${Number(d)}/${Number(m)}`;
};

export default async function AnalyticsPage({ searchParams }: { searchParams: Promise<{ days?: string }> }) {
  await connection();
  await requireStaff("reports.view");
  const { days: raw } = await searchParams;
  const days = RANGES.find((r) => String(r) === raw) ?? 14;

  const [a, beds, stock] = await Promise.all([hospitalAnalytics(pool(), days), occupancy(pool()), stockOverview(pool())]);

  const totalBeds = beds.reduce((n, w) => n + w.total, 0);
  const occupied = beds.reduce((n, w) => n + w.occupied, 0);
  const low = stock.filter((s) => s.status !== "ok").length;
  const expired = stock.filter((s) => s.expired > 0).length;

  return (
    <>
      <PageHeader
        title="Hospital analytics"
        description={`${formatDateOnly(a.from)} to ${formatDateOnly(a.to)}`}
        actions={
          <div className="flex gap-1.5">
            {RANGES.map((r) => (
              <Link
                key={r}
                href={`/analytics?days=${r}`}
                className={`rounded-lg border px-2.5 py-1 text-sm transition-colors ${
                  r === days ? "border-primary bg-primary-soft text-primary" : "border-border text-muted hover:text-text"
                }`}
              >
                {r} days
              </Link>
            ))}
          </div>
        }
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Patients seen" value={a.visits.completed} tone="ok" hint={`${a.visits.walk_in} walk-in · ${a.visits.appointment} booked`} />
        <Stat label="Average wait" value={a.wait.average_minutes === null ? "—" : `${a.wait.average_minutes} min`} hint={a.wait.longest_minutes ? `longest ${a.wait.longest_minutes} min` : "to see the doctor"} />
        <Stat label="Collected" value={inr(a.money.collected - a.money.refunded)} tone="ok" hint={`${inr(a.money.billed)} billed`} />
        <Stat label="Outstanding" value={inr(a.money.outstanding)} tone={a.money.outstanding ? "warn" : "neutral"} hint="all unpaid invoices" href="/billing?view=unpaid" />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Card title="Patients per day">
          <div className="p-4">
            <BarChart data={a.visits_by_day.map((d) => ({ label: short(d.date), value: d.value }))} />
          </div>
        </Card>
        <Card title="Money collected per day">
          <div className="p-4">
            <BarChart tone="ok" format={inr} data={a.collected_by_day.map((d) => ({ label: short(d.date), value: Math.max(0, d.value) }))} />
          </div>
        </Card>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        <Card title="Doctors">
          <RankedList
            rows={a.doctors.map((d) => ({
              label: d.name,
              value: d.seen,
              sub: `${d.department}${d.avg_wait !== null ? ` · waits ${d.avg_wait} min` : ""}`,
            }))}
            format={(n) => `${n} seen`}
          />
        </Card>
        <Card title="Common diagnoses">
          <RankedList rows={a.diagnoses.map((d) => ({ label: d.diagnosis, value: d.n }))} format={(n) => `${n}`} />
        </Card>
        <Card title="Medicines dispensed">
          <RankedList rows={a.medicines.map((m) => ({ label: m.name, value: m.quantity, sub: inr(m.revenue) }))} format={(n) => `${n} units`} />
        </Card>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        <Card title="Beds">
          <div className="space-y-3 p-4">
            <div className="flex items-baseline justify-between">
              <span className="text-sm text-muted">Occupancy now</span>
              <span className="num text-2xl font-semibold">{totalBeds ? Math.round((occupied / totalBeds) * 100) : 0}%</span>
            </div>
            <RankedList rows={beds.map((w) => ({ label: w.name, value: w.occupied, sub: `${w.occupied} of ${w.total} beds` }))} format={(n) => `${n} in`} />
            <dl className="grid grid-cols-3 gap-2 border-t border-border pt-3 text-center text-sm">
              <div>
                <dt className="text-xs text-muted">Admitted</dt>
                <dd className="num font-semibold">{a.inpatients.admitted}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted">Discharged</dt>
                <dd className="num font-semibold">{a.inpatients.discharged}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted">Avg stay</dt>
                <dd className="num font-semibold">{a.inpatients.average_stay_days === null ? "—" : `${a.inpatients.average_stay_days} d`}</dd>
              </div>
            </dl>
          </div>
        </Card>
        <Card title="Departments">
          <RankedList rows={a.departments.map((d) => ({ label: d.department, value: d.visits }))} format={(n) => `${n} visits`} />
        </Card>
        <Card title="Pharmacy stock">
          <div className="space-y-2 p-4 text-sm">
            <div className="flex justify-between"><span className="text-muted">Pharmacy sales</span><span className="num font-medium">{inr(a.money.pharmacy_sales)}</span></div>
            <div className="flex justify-between"><span className="text-muted">Low or out of stock</span><Link href="/pharmacy/stock?view=low" className={`num font-medium ${low ? "text-warn" : ""}`}>{low}</Link></div>
            <div className="flex justify-between"><span className="text-muted">With expired units</span><Link href="/pharmacy/stock?view=expired" className={`num font-medium ${expired ? "text-danger" : ""}`}>{expired}</Link></div>
          </div>
        </Card>
      </div>
    </>
  );
}
