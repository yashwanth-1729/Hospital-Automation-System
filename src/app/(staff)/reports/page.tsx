import Link from "next/link";
import { connection } from "next/server";
import { Badge, Card, Empty, PageHeader, Stat, Td, Th } from "@/components/ui";
import { formatDateTime } from "@/lib/time";
import { generateDailySummary } from "@/server/ai/summary";
import { getReport, summaryMetrics } from "@/server/reports";
import { generateSummaryAction } from "./actions";
import { requireStaff } from "@/server/auth/guard";

export const metadata = { title: "Reports" };

const RANGES = [7, 30, 90];

function duration(seconds: number | null): string {
  if (seconds === null) return "—";
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${(seconds / 3600).toFixed(1)}h`;
}

function Bars({ trend }: { trend: { day: string; leads: number; booked: number }[] }) {
  const max = Math.max(1, ...trend.map((t) => t.leads));
  return (
    <div className="flex h-28 items-end gap-1 px-4 py-3" role="img" aria-label="Daily enquiries and bookings">
      {trend.map((t) => (
        <div key={t.day} className="group relative flex-1" title={`${t.day}: ${t.leads} enquiries, ${t.booked} booked`}>
          <div className="relative w-full rounded-t bg-primary-soft" style={{ height: `${(t.leads / max) * 100}%`, minHeight: "2px" }}>
            <div
              className="absolute inset-x-0 bottom-0 rounded-t bg-primary"
              style={{ height: t.leads ? `${(t.booked / t.leads) * 100}%` : "0%" }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

export default async function ReportsPage({ searchParams }: { searchParams: Promise<{ days?: string }> }) {
  await connection();
  await requireStaff("reports.view");
  const requested = Number((await searchParams).days);
  const days = RANGES.includes(requested) ? requested : 7;

  const report = await getReport(days);
  const summary = await generateDailySummary(summaryMetrics(report));
  const { funnel, response, departments, sources, health, trend } = report;

  return (
    <>
      <PageHeader
        title="Management report"
        description="The numbers a hospital owner cannot get from the HMS: response speed, conversion, leakage and workflow health."
        actions={
          <div className="flex gap-2 text-sm">
            {RANGES.map((r) => (
              <Link
                key={r}
                href={`/reports?days=${r}`}
                className={`rounded-full border px-3 py-1 ${r === days ? "border-primary bg-primary-soft text-primary" : "border-border text-muted hover:text-text"}`}
              >
                {r} days
              </Link>
            ))}
          </div>
        }
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Enquiries" value={funnel.enquiries} hint={`last ${days} days`} />
        <Stat
          label="Booked"
          value={funnel.auto_booked + funnel.staff_booked}
          tone="ok"
          hint={`${funnel.conversion_rate ?? 0}% of enquiries`}
        />
        <Stat label="Handled without staff" value={funnel.automation_rate === null ? "—" : `${funnel.automation_rate}%`} tone="primary" hint="of all bookings" />
        <Stat label="Median first response" value={duration(response.median_seconds)} hint={response.under_five_minutes === null ? "—" : `${response.under_five_minutes}% under 5 min`} />
      </div>

      <div className="mt-6 grid gap-6 xl:grid-cols-3">
        <Card title="What happened to the enquiries" className="xl:col-span-2">
          <Bars trend={trend} />
          <dl className="grid grid-cols-2 gap-x-4 gap-y-3 border-t border-border px-4 py-4 sm:grid-cols-4">
            {[
              ["Booked automatically", funnel.auto_booked],
              ["Booked by staff", funnel.staff_booked],
              ["Sent to review", funnel.needs_review],
              ["No slot available", funnel.no_slot],
              ["Attended", funnel.attended],
              ["No-shows", funnel.no_shows],
              ["Cancelled", funnel.cancelled],
              ["Messages sent", health.messages_sent],
            ].map(([label, value]) => (
              <div key={label as string}>
                <dt className="text-xs text-muted">{label}</dt>
                <dd className="num text-lg font-semibold">{value as number}</dd>
              </div>
            ))}
          </dl>
        </Card>

        <Card
          title="Daily summary"
          action={
            <form action={generateSummaryAction}>
              <input type="hidden" name="days" value={days} />
              <button className="text-xs text-primary hover:underline">Regenerate</button>
            </form>
          }
        >
          <div className="space-y-3 p-4 text-sm">
            <p className="font-medium">{summary.summary.headline}</p>
            {([
              ["Wins", summary.summary.wins, "ok"],
              ["Needs attention", summary.summary.exceptions, "warn"],
              ["Overdue", summary.summary.overdue_items, "danger"],
              ["Questions for management", summary.summary.questions_for_management, "info"],
            ] as const).map(([label, items, tone]) =>
              items.length ? (
                <div key={label}>
                  <Badge tone={tone}>{label}</Badge>
                  <ul className="mt-1.5 list-disc space-y-1 pl-5 text-muted">
                    {items.map((i) => (
                      <li key={i}>{i}</li>
                    ))}
                  </ul>
                </div>
              ) : null,
            )}
            <p className="border-t border-border pt-3 text-xs text-muted">
              {summary.provider === "openai_compatible"
                ? `Written by ${summary.model} from aggregate numbers only — no patient data is sent to the AI.`
                : summary.provider === "rules_fallback"
                  ? "AI unavailable; generated from the numbers directly."
                  : "Generated from the numbers directly (no AI configured)."}{" "}
              {formatDateTime(summary.generatedAt)}
            </p>
          </div>
        </Card>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Card title="Departments">
          {departments.length === 0 ? (
            <Empty>No department activity yet.</Empty>
          ) : (
            <table className="w-full">
              <thead className="border-b border-border">
                <tr>
                  <Th>Department</Th>
                  <Th>Enquiries</Th>
                  <Th>Booked</Th>
                  <Th>No-shows</Th>
                  <Th>Rating</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {departments.map((d) => (
                  <tr key={d.department}>
                    <Td>{d.department}</Td>
                    <Td className="num">{d.leads}</Td>
                    <Td className="num">{d.booked}</Td>
                    <Td className="num">
                      {d.no_shows}
                      {d.recovered > 0 && <span className="text-ok"> ({d.recovered} recovered)</span>}
                    </Td>
                    <Td className="num">{d.avg_rating === null ? "—" : `${d.avg_rating}/5`}</Td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>

        <Card title="Where enquiries came from">
          {sources.length === 0 ? (
            <Empty>No enquiries in this period.</Empty>
          ) : (
            <table className="w-full">
              <thead className="border-b border-border">
                <tr>
                  <Th>Source</Th>
                  <Th>Enquiries</Th>
                  <Th>Booked</Th>
                  <Th>Conversion</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {sources.map((s) => (
                  <tr key={s.source}>
                    <Td>{s.source}</Td>
                    <Td className="num">{s.leads}</Td>
                    <Td className="num">{s.booked}</Td>
                    <Td className="num">{s.conversion_rate === null ? "—" : `${s.conversion_rate}%`}</Td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>

      <Card title="Workflow health" className="mt-6">
        <div className="grid gap-4 border-b border-border px-4 py-4 sm:grid-cols-4">
          <div>
            <div className="text-xs text-muted">Messages sent</div>
            <div className="num text-lg font-semibold">{health.messages_sent}</div>
          </div>
          <div>
            <div className="text-xs text-muted">Failed / skipped</div>
            <div className="num text-lg font-semibold">
              {health.messages_failed} / {health.messages_skipped}
            </div>
          </div>
          <div>
            <div className="text-xs text-muted">Automation steps that died</div>
            <div className={`num text-lg font-semibold ${health.jobs_dead ? "text-danger" : ""}`}>{health.jobs_dead}</div>
          </div>
          <div>
            <div className="text-xs text-muted">Median time to resolve</div>
            <div className="num text-lg font-semibold">{health.median_resolution_minutes === null ? "—" : `${health.median_resolution_minutes}m`}</div>
          </div>
        </div>
        {health.exceptions_by_type.length === 0 ? (
          <Empty>No exceptions raised in this period.</Empty>
        ) : (
          <table className="w-full">
            <thead className="border-b border-border">
              <tr>
                <Th>Exception</Th>
                <Th>Severity</Th>
                <Th>Open</Th>
                <Th>Resolved</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {health.exceptions_by_type.map((e) => (
                <tr key={`${e.error_type}-${e.severity}`}>
                  <Td className="font-mono text-xs">{e.error_type}</Td>
                  <Td>{e.severity}</Td>
                  <Td className="num">{e.open}</Td>
                  <Td className="num">{e.resolved}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </>
  );
}
