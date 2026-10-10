import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { randomUUID } from "node:crypto";
import { Badge, Card, Empty, PageHeader, Td, Th } from "@/components/ui";
import { many, pool } from "@/lib/db";
import { can } from "@/lib/rbac";
import { formatDateOnly, formatDateTime } from "@/lib/time";
import { requireStaff } from "@/server/auth/guard";
import { DISCOUNT_LIMIT_PERCENT, getInvoice, METHOD_LABEL } from "@/server/billing/invoices";
import { inr, STATUS } from "../status";
import { AddLineForm, DiscountForm, IssueForm, PayForm, RefundForm, RemoveLineButton, VoidForm } from "./forms";

export const metadata = { title: "Invoice" };

export default async function InvoicePage({ params }: { params: Promise<{ invoiceId: string }> }) {
  await connection();
  const user = await requireStaff("billing.view");
  const { invoiceId } = await params;
  const inv = await getInvoice(pool(), invoiceId);
  if (!inv) notFound();

  const manage = can(user.role, "billing.manage");
  const collect = can(user.role, "billing.collect");
  const isDraft = inv.status === "draft";
  const canPay = collect && (inv.status === "issued" || inv.status === "partially_paid");
  const services = isDraft && manage ? await many<{ name: string; default_price: number; tax_rate: number }>(
    pool(),
    `SELECT name, default_price::float AS default_price, tax_rate::float AS tax_rate FROM services WHERE active ORDER BY category, name`,
  ) : [];
  const s = STATUS[inv.status];

  return (
    <>
      <PageHeader
        title={inv.invoice_number ?? "Draft invoice"}
        description={`${inv.patient_name} · ${inv.uhid}`}
        actions={
          <div className="flex items-center gap-3">
            {inv.status !== "draft" && (
              <Link href={`/billing/${inv.invoice_id}/print`} className="rounded-lg border border-border px-3 py-2 text-sm hover:border-primary hover:text-primary">
                Print
              </Link>
            )}
            <Link href="/billing" className="text-sm text-muted hover:text-text">
              Back to billing
            </Link>
          </div>
        }
      />

      <div className="mb-6 flex flex-wrap items-center gap-3 text-sm">
        <Badge tone={s.tone}>{s.label}</Badge>
        {inv.issued_at && <span className="text-muted">Issued {formatDateTime(inv.issued_at)}</span>}
        {inv.due_date && inv.status !== "paid" && inv.status !== "void" && <span className="text-muted">Due {formatDateOnly(inv.due_date)}</span>}
        {inv.status === "void" && <span className="text-danger">Void: {inv.void_reason}</span>}
      </div>

      <div className="grid gap-6 xl:grid-cols-3">
        <div className="space-y-6 xl:col-span-2">
          <Card title="Charges">
            {inv.lines.length === 0 ? (
              <Empty>No charges yet.</Empty>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead className="border-b border-border">
                    <tr>
                      <Th>Description</Th>
                      <Th className="text-right">Qty</Th>
                      <Th className="text-right">Rate</Th>
                      <Th className="text-right">Amount</Th>
                      {isDraft && manage && <Th></Th>}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {inv.lines.map((l) => (
                      <tr key={l.line_id}>
                        <Td>
                          {l.description}
                          {l.tax_rate > 0 && <div className="text-xs text-muted">GST {l.tax_rate}%</div>}
                        </Td>
                        <Td className="num text-right">{l.quantity}</Td>
                        <Td className="num text-right">{inr(l.unit_price)}</Td>
                        <Td className="num text-right font-medium">{inr(l.line_total)}</Td>
                        {isDraft && manage && (
                          <Td className="text-right">
                            <RemoveLineButton invoiceId={inv.invoice_id} lineId={l.line_id} />
                          </Td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                  <tfoot className="border-t border-border text-sm">
                    <tr>
                      <td colSpan={3} className="px-4 py-2 text-right text-muted">Subtotal</td>
                      <td className="num px-4 py-2 text-right">{inr(inv.subtotal)}</td>
                      {isDraft && manage && <td />}
                    </tr>
                    {inv.discount_amount > 0 && (
                      <tr>
                        <td colSpan={3} className="px-4 py-2 text-right text-muted">Discount{inv.discount_reason ? ` (${inv.discount_reason})` : ""}</td>
                        <td className="num px-4 py-2 text-right">−{inr(inv.discount_amount)}</td>
                        {isDraft && manage && <td />}
                      </tr>
                    )}
                    {inv.tax_amount > 0 && (
                      <tr>
                        <td colSpan={3} className="px-4 py-2 text-right text-muted">GST</td>
                        <td className="num px-4 py-2 text-right">{inr(inv.tax_amount)}</td>
                        {isDraft && manage && <td />}
                      </tr>
                    )}
                    <tr className="font-semibold">
                      <td colSpan={3} className="px-4 py-3 text-right">Total</td>
                      <td className="num px-4 py-3 text-right text-base">{inr(inv.total)}</td>
                      {isDraft && manage && <td />}
                    </tr>
                    {inv.amount_paid > 0 && (
                      <tr>
                        <td colSpan={3} className="px-4 py-2 text-right text-muted">Paid</td>
                        <td className="num px-4 py-2 text-right text-ok">{inr(inv.amount_paid)}</td>
                        {isDraft && manage && <td />}
                      </tr>
                    )}
                    {inv.status !== "draft" && inv.status !== "void" && (
                      <tr className="font-semibold">
                        <td colSpan={3} className="px-4 py-2 text-right">Balance due</td>
                        <td className={`num px-4 py-2 text-right ${inv.balance > 0 ? "text-warn" : "text-ok"}`}>{inr(inv.balance)}</td>
                      </tr>
                    )}
                  </tfoot>
                </table>
              </div>
            )}
          </Card>

          {isDraft && manage && (
            <>
              <Card title="Add a charge">
                <div className="p-4">
                  <AddLineForm invoiceId={inv.invoice_id} services={services} />
                </div>
              </Card>
              <Card title="Discount">
                <div className="p-4">
                  <DiscountForm invoiceId={inv.invoice_id} limit={DISCOUNT_LIMIT_PERCENT} isAdmin={can(user.role, "billing.discount_large")} />
                </div>
              </Card>
              <IssueForm invoiceId={inv.invoice_id} disabled={inv.lines.length === 0} />
            </>
          )}
        </div>

        <div className="space-y-6">
          {canPay && (
            <Card title="Take payment">
              <div className="p-4">
                <PayForm invoiceId={inv.invoice_id} balance={inv.balance} idempotencyKey={randomUUID()} />
              </div>
            </Card>
          )}

          <Card title="Payments">
            {inv.payments.length === 0 ? (
              <Empty>None received.</Empty>
            ) : (
              <ul className="divide-y divide-border text-sm">
                {inv.payments.map((p) => (
                  <li key={p.payment_id} className="flex justify-between gap-3 px-4 py-3">
                    <div className="min-w-0">
                      <div className="font-medium">
                        {p.kind === "refund" ? "Refund" : METHOD_LABEL[p.method]}
                        {p.kind === "refund" && <span className="font-normal text-muted"> · {METHOD_LABEL[p.method]}</span>}
                      </div>
                      <div className="truncate text-xs text-muted">
                        {p.receipt_number} · {formatDateTime(p.received_at)} · {p.received_by_name}
                        {p.reference ? ` · ${p.reference}` : ""}
                        {p.reason ? ` · ${p.reason}` : ""}
                      </div>
                    </div>
                    <span className={`num shrink-0 font-medium ${p.kind === "refund" ? "text-danger" : "text-ok"}`}>
                      {p.kind === "refund" ? "−" : ""}
                      {inr(p.amount)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {manage && inv.status !== "draft" && inv.status !== "void" && (
            <>
              {inv.amount_paid > 0 && (
                <Card title="Refund">
                  <div className="p-4">
                    <RefundForm invoiceId={inv.invoice_id} max={inv.amount_paid} />
                  </div>
                </Card>
              )}
              <Card title="Void this invoice">
                <div className="p-4">
                  <VoidForm invoiceId={inv.invoice_id} hasPayments={inv.amount_paid > 0} />
                </div>
              </Card>
            </>
          )}
          {manage && isDraft && inv.lines.length === 0 && (
            <Card title="Discard">
              <div className="p-4">
                <VoidForm invoiceId={inv.invoice_id} hasPayments={false} />
              </div>
            </Card>
          )}
        </div>
      </div>
    </>
  );
}
