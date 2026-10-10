import Link from "next/link";
import { connection } from "next/server";
import { AutoRefresh } from "@/components/client";
import { Badge, Card, Empty, PageHeader, Stat, Td, Th } from "@/components/ui";
import { pool } from "@/lib/db";
import { can } from "@/lib/rbac";
import { formatDateTime } from "@/lib/time";
import { requireStaff } from "@/server/auth/guard";
import { daySummary, listInvoices, METHOD_LABEL, visitsToBill } from "@/server/billing/invoices";
import { searchPatients } from "@/server/clinic/patients";
import { createBlankAction, createForVisitAction } from "./actions";
import { inr, STATUS } from "./status";

export const metadata = { title: "Billing" };

const VIEWS = [
  { key: "open", label: "Open" },
  { key: "unpaid", label: "Unpaid" },
  { key: "paid", label: "Paid" },
  { key: "draft", label: "Drafts" },
  { key: "void", label: "Void" },
  { key: "all", label: "All" },
] as const;


export default async function BillingPage({ searchParams }: { searchParams: Promise<{ view?: string; q?: string; p?: string; error?: string }> }) {
  await connection();
  const user = await requireStaff("billing.view");
  const manage = can(user.role, "billing.manage");
  const { view = "open", q = "", p = "", error } = await searchParams;
  const valid = VIEWS.some((v) => v.key === view) ? (view as (typeof VIEWS)[number]["key"]) : "open";

  const [summary, toBill, invoices, patients] = await Promise.all([
    daySummary(pool()),
    manage ? visitsToBill(pool()) : Promise.resolve([]),
    listInvoices(pool(), { view: valid, q }),
    manage && p.trim() ? searchPatients(pool(), p, 6) : Promise.resolve([]),
  ]);

  return (
    <>
      <AutoRefresh seconds={15} />
      <PageHeader
        title="Billing"
        description="Invoices built from what happened in the consulting room and the pharmacy, and the money received."
        actions={
          <Link href="/billing/day-book" className="rounded-lg border border-border px-3 py-2 text-sm hover:border-primary hover:text-primary">
            Day book
          </Link>
        }
      />
      {error && <p role="alert" className="mb-4 rounded-lg bg-danger-soft px-4 py-2 text-sm text-danger">{error}</p>}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Collected today" value={inr(summary.net)} tone="ok" hint={summary.by_method.map((m) => `${METHOD_LABEL[m.method]} ${inr(m.amount)}`).join(" · ") || "nothing yet"} />
        <Stat label="Billed today" value={inr(summary.billed)} hint={`${summary.invoices_issued} invoice${summary.invoices_issued === 1 ? "" : "s"}`} />
        <Stat label="Outstanding" value={inr(summary.outstanding_total)} tone={summary.outstanding_count ? "warn" : "neutral"} hint={`${summary.outstanding_count} unpaid`} href="/billing?view=unpaid" />
        <Stat label="To bill" value={toBill.length} tone={toBill.length ? "info" : "neutral"} hint="visits with charges not invoiced" />
      </div>

      {manage && toBill.length > 0 && (
        <Card title="Ready to bill" className="mt-6">
          <ul className="divide-y divide-border">
            {toBill.map((v) => (
              <li key={v.visit_id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                <div>
                  <div className="font-medium">
                    {v.patient_name} <span className="text-xs font-normal text-muted">· token {v.token_number}</span>
                  </div>
                  <div className="text-xs text-muted">
                    {v.uhid} · {v.doctor_name} · {v.unbilled_items} item{v.unbilled_items === 1 ? "" : "s"} not billed
                  </div>
                </div>
                <form action={createForVisitAction}>
                  <input type="hidden" name="visit_id" value={v.visit_id} />
                  <button className="rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-white hover:opacity-90">
                    {v.draft_invoice_id ? "Open draft" : "Create invoice"}
                  </button>
                </form>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <div className="mt-6 grid gap-6 xl:grid-cols-3">
        <Card title="Invoices" className="xl:col-span-2">
          <div className="flex flex-wrap items-center gap-2 border-b border-border p-3">
            {VIEWS.map((v) => (
              <Link
                key={v.key}
                href={`/billing?view=${v.key}${q ? `&q=${encodeURIComponent(q)}` : ""}`}
                className={`rounded-lg border px-2.5 py-1 text-sm transition-colors ${
                  valid === v.key ? "border-primary bg-primary-soft text-primary" : "border-border text-muted hover:text-text"
                }`}
              >
                {v.label}
              </Link>
            ))}
            <form action="/billing" className="ml-auto">
              <input type="hidden" name="view" value={valid} />
              <input
                name="q"
                defaultValue={q}
                placeholder="Name, UHID or invoice no."
                aria-label="Search invoices"
                className="rounded-lg border border-border bg-surface px-3 py-1.5 text-sm outline-none focus:border-primary"
              />
            </form>
          </div>
          {invoices.length === 0 ? (
            <Empty>No invoices here.</Empty>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="border-b border-border">
                  <tr>
                    <Th>Invoice</Th>
                    <Th>Patient</Th>
                    <Th>Status</Th>
                    <Th className="text-right">Total</Th>
                    <Th className="text-right">Balance</Th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {invoices.map((i) => (
                    <tr key={i.invoice_id} className="hover:bg-surface-2">
                      <Td>
                        <Link href={`/billing/${i.invoice_id}`} className="num font-medium hover:text-primary">
                          {i.invoice_number ?? "Draft"}
                        </Link>
                        <div className="text-xs text-muted">{formatDateTime(i.issued_at ?? i.created_at)}</div>
                      </Td>
                      <Td>
                        {i.patient_name}
                        <div className="text-xs text-muted">{i.uhid}</div>
                      </Td>
                      <Td><Badge tone={STATUS[i.status].tone}>{STATUS[i.status].label}</Badge></Td>
                      <Td className="num text-right">{inr(i.total)}</Td>
                      <Td className={`num text-right ${i.balance > 0 && i.status !== "draft" && i.status !== "void" ? "font-medium text-warn" : "text-muted"}`}>
                        {i.status === "draft" || i.status === "void" ? "—" : inr(i.balance)}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        {manage && (
          <Card title="Bill something else">
            <form action="/billing" className="border-b border-border p-3">
              <input type="hidden" name="view" value={valid} />
              <input
                name="p"
                defaultValue={p}
                placeholder="Find a patient"
                aria-label="Find a patient to bill"
                className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-primary"
              />
            </form>
            {p.trim() && patients.length === 0 && <Empty>No patient matches.</Empty>}
            <ul className="divide-y divide-border">
              {patients.map((pt) => (
                <li key={pt.patient_id} className="flex items-center justify-between gap-3 px-4 py-3">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium">{pt.full_name}</div>
                    <div className="text-xs text-muted">{pt.uhid}</div>
                  </div>
                  <form action={createBlankAction}>
                    <input type="hidden" name="patient_id" value={pt.patient_id} />
                    <button className="rounded-lg border border-border px-2.5 py-1 text-xs hover:border-primary hover:text-primary">New invoice</button>
                  </form>
                </li>
              ))}
            </ul>
          </Card>
        )}
      </div>
    </>
  );
}
