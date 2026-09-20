import Link from "next/link";
import { connection } from "next/server";
import { Badge, Card, Empty, PageHeader, Td, Th } from "@/components/ui";
import { formatDateOnly } from "@/lib/time";
import { buildReport, formatRupees, listAudits } from "@/server/audit";
import { createAuditAction } from "./actions";

export const metadata = { title: "Audits" };

const inputClass = "mt-1 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-primary";

export default async function AuditsPage() {
  await connection();
  const audits = await listAudits();

  return (
    <>
      <PageHeader
        title="Hospital audits"
        description="The paid discovery step: interview the hospital, measure the leakage in their own numbers, and let the result choose the pilot."
      />

      <Card title="Start a new audit" className="mb-6">
        <form action={createAuditAction} className="grid gap-4 p-4 sm:grid-cols-3">
          <label className="block text-sm font-medium sm:col-span-2">
            Hospital name
            <input name="hospital_name" required placeholder="Sunrise Multispeciality Hospital" className={inputClass} />
          </label>
          <label className="block text-sm font-medium">
            City
            <input name="city" placeholder="Hyderabad" className={inputClass} />
          </label>
          <label className="block text-sm font-medium">
            Contact person
            <input name="contact_name" placeholder="Dr. Ramesh" className={inputClass} />
          </label>
          <label className="block text-sm font-medium">
            Their role
            <input name="contact_role" placeholder="Managing Director" className={inputClass} />
          </label>
          <label className="block text-sm font-medium">
            Audit by
            <input name="conducted_by" placeholder="Your name" className={inputClass} />
          </label>
          <div className="sm:col-span-3">
            <button className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white hover:opacity-90">
              Create audit
            </button>
          </div>
        </form>
      </Card>

      <Card title="Audits">
        {audits.length === 0 ? (
          <Empty>No audits yet. Create one before your next discovery call.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="border-b border-border">
                <tr>
                  <Th>Hospital</Th>
                  <Th>Contact</Th>
                  <Th>Date</Th>
                  <Th>Estimated leakage</Th>
                  <Th>Recommended pilot</Th>
                  <Th />
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {audits.map((a) => {
                  const report = buildReport(a);
                  return (
                    <tr key={a.audit_id} className="hover:bg-surface-2">
                      <Td>
                        <Link href={`/audits/${a.audit_id}`} className="font-medium hover:text-primary">{a.hospital_name}</Link>
                        <div className="text-xs text-muted">{a.city ?? "—"}</div>
                      </Td>
                      <Td>
                        {a.contact_name ?? "—"}
                        <div className="text-xs text-muted">{a.contact_role ?? ""}</div>
                      </Td>
                      <Td className="num">{formatDateOnly(a.conducted_on)}</Td>
                      <Td className="num">
                        {report.leakage.monthly_total > 0 ? `${formatRupees(report.leakage.monthly_total)}/mo` : "—"}
                      </Td>
                      <Td>
                        {report.leakage.monthly_total > 0 ? report.recommended.title : <span className="text-muted">not scored yet</span>}
                      </Td>
                      <Td>
                        <div className="flex items-center gap-2">
                          <Badge tone={a.status === "final" ? "ok" : "neutral"}>{a.status}</Badge>
                          <Link href={`/audits/${a.audit_id}/report`} className="text-xs text-primary">Report</Link>
                        </div>
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
