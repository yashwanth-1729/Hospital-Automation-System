import Link from "next/link";
import { connection } from "next/server";
import { AutoRefresh } from "@/components/client";
import { Card, Empty, LeadStatus, PageHeader, Td, Th } from "@/components/ui";
import { maskPhone } from "@/lib/phone";
import { formatDateTime, formatSlot } from "@/lib/time";
import { listLeads } from "@/server/queries";

export const metadata = { title: "Leads" };

const FILTERS = [
  { value: undefined, label: "All" },
  { value: "booked", label: "Booked" },
  { value: "needs_review", label: "Needs review" },
  { value: "no_slot", label: "No slot" },
  { value: "new", label: "Processing" },
];

export default async function LeadsPage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  await connection();
  const { status } = await searchParams;
  const valid = FILTERS.some((f) => f.value === status) ? status : undefined;
  const leads = await listLeads({ status: valid, limit: 200 });

  return (
    <>
      <AutoRefresh seconds={5} />
      <PageHeader title="Leads" description="Every patient enquiry, from every source, with what the automation did about it." />
      <div className="mb-4 flex flex-wrap gap-2">
        {FILTERS.map((f) => (
          <Link
            key={f.label}
            href={f.value ? `/leads?status=${f.value}` : "/leads"}
            className={`rounded-full border px-3 py-1 text-sm ${
              f.value === valid ? "border-primary bg-primary-soft text-primary" : "border-border text-muted hover:text-text"
            }`}
          >
            {f.label}
          </Link>
        ))}
      </div>
      <Card>
        {leads.length === 0 ? (
          <Empty>No leads match this filter.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="border-b border-border">
                <tr>
                  <Th>Patient</Th>
                  <Th>Source</Th>
                  <Th>Department</Th>
                  <Th>Status</Th>
                  <Th>Appointment</Th>
                  <Th className="text-right">Received</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {leads.map((l) => (
                  <tr key={l.lead_id} className="hover:bg-surface-2">
                    <Td>
                      <Link href={`/leads/${l.lead_id}`} className="font-medium hover:text-primary">{l.full_name}</Link>
                      <div className="num text-xs text-muted">{maskPhone(l.phone)}</div>
                    </Td>
                    <Td className="text-muted">{l.source}</Td>
                    <Td>{l.department ?? <span className="text-muted">{l.department_requested ?? "—"}</span>}</Td>
                    <Td><LeadStatus status={l.status} /></Td>
                    <Td className="num">{l.slot_start ? formatSlot(l.slot_start) : <span className="text-muted">—</span>}</Td>
                    <Td className="num text-right text-muted">{formatDateTime(l.created_at)}</Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
