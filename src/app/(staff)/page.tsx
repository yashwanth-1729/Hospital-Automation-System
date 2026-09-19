import Link from "next/link";
import { connection } from "next/server";
import { AutoRefresh } from "@/components/client";
import { Card, Empty, LeadStatus, Mono, PageHeader, Severity, Stat, Td, Th } from "@/components/ui";
import { formatDateTime } from "@/lib/time";
import { getDashboardStats, listExceptions, listLeads } from "@/server/queries";

export const metadata = { title: "Dashboard" };

function formatDuration(seconds: number | null): string {
  if (seconds === null) return "—";
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${(seconds / 3600).toFixed(1)}h`;
}

export default async function DashboardPage() {
  await connection();
  const [stats, leads, exceptions] = await Promise.all([getDashboardStats(), listLeads({ limit: 8 }), listExceptions("open")]);

  return (
    <>
      <AutoRefresh seconds={5} />
      <PageHeader title="Today" description="Live view of patient enquiries, bookings and items that need a person." />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="New enquiries" value={stats.leads_today} hint="since midnight IST" href="/leads" />
        <Stat label="Booked" value={stats.booked_today} tone="ok" hint={`${stats.upcoming_appointments} upcoming in total`} href="/appointments" />
        <Stat
          label="Need a person"
          value={stats.needs_review_open + stats.no_slot_open}
          tone={stats.needs_review_open + stats.no_slot_open ? "warn" : "neutral"}
          hint={`${stats.needs_review_open} review · ${stats.no_slot_open} no slot`}
          href="/exceptions"
        />
        <Stat label="First response" value={formatDuration(stats.avg_first_response_seconds)} hint="average, today" tone="primary" />
      </div>

      <div className="mt-6 grid gap-6 xl:grid-cols-5">
        <Card title="Latest enquiries" action={<Link href="/leads" className="text-xs text-primary">View all</Link>} className="xl:col-span-3">
          {leads.length === 0 ? (
            <Empty>
              No enquiries yet. Open the <a className="text-primary underline" href="/enquiry" target="_blank">patient form</a> to send one.
            </Empty>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="border-b border-border">
                  <tr>
                    <Th>Patient</Th>
                    <Th>Department</Th>
                    <Th>Status</Th>
                    <Th className="text-right">Received</Th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {leads.map((l) => (
                    <tr key={l.lead_id} className="hover:bg-surface-2">
                      <Td>
                        <Link href={`/leads/${l.lead_id}`} className="font-medium hover:text-primary">{l.full_name}</Link>
                        <div className="text-xs text-muted">{l.source}</div>
                      </Td>
                      <Td>{l.department ?? <span className="text-muted">{l.department_requested ?? "—"}</span>}</Td>
                      <Td><LeadStatus status={l.status} /></Td>
                      <Td className="text-right text-muted num">{formatDateTime(l.created_at)}</Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <Card
          title={`Open exceptions (${stats.exceptions_open})`}
          action={<Link href="/exceptions" className="text-xs text-primary">Work queue</Link>}
          className="xl:col-span-2"
        >
          {exceptions.length === 0 ? (
            <Empty>Nothing needs attention.</Empty>
          ) : (
            <ul className="divide-y divide-border">
              {exceptions.slice(0, 6).map((e) => (
                <li key={e.exception_id} className="px-4 py-3">
                  <div className="flex items-center gap-2">
                    <Severity level={e.severity} />
                    <Mono>{e.error_type}</Mono>
                  </div>
                  <p className="mt-1 text-sm">{e.summary}</p>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <p className="mt-6 text-xs text-muted">
        Messages sent today: <span className="num">{stats.messages_today}</span>
        {stats.messages_failed_today > 0 && <span className="text-danger"> · failed: {stats.messages_failed_today}</span>}
      </p>
    </>
  );
}
