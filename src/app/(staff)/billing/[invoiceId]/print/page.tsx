import { notFound } from "next/navigation";
import { connection } from "next/server";
import { pool } from "@/lib/db";
import { env } from "@/lib/env";
import { formatAge } from "@/lib/age";
import { one } from "@/lib/db";
import { formatDateOnly, formatDateTime } from "@/lib/time";
import { requireStaff } from "@/server/auth/guard";
import { getInvoice, METHOD_LABEL } from "@/server/billing/invoices";
import { inr } from "../../status";
import { PrintButton } from "./print-button";

export const metadata = { title: "Invoice" };

export default async function PrintInvoicePage({ params }: { params: Promise<{ invoiceId: string }> }) {
  await connection();
  await requireStaff("billing.view");
  const { invoiceId } = await params;
  const inv = await getInvoice(pool(), invoiceId);
  if (!inv || inv.status === "draft") notFound();
  const e = env();
  const p = await one<{ gender: string | null; date_of_birth: string | null; dob_estimated: boolean }>(
    pool(),
    `SELECT gender, date_of_birth, dob_estimated FROM patients WHERE patient_id = $1`,
    [inv.patient_id],
  );

  return (
    <div className="mx-auto max-w-3xl rounded-xl border border-border bg-surface p-8 print:border-0 print:p-0">
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{e.HOSPITAL_NAME}</h1>
          <p className="text-sm text-muted">{e.HOSPITAL_CONTACT}</p>
        </div>
        <div className="text-right">
          <div className="text-xs font-medium tracking-wide text-muted uppercase">{inv.status === "void" ? "Void invoice" : "Invoice"}</div>
          <div className="num text-lg font-semibold">{inv.invoice_number}</div>
          <div className="text-xs text-muted">{inv.issued_at ? formatDateTime(inv.issued_at) : ""}</div>
        </div>
      </div>

      <div className="mb-6 grid grid-cols-2 gap-4 border-y border-border py-4 text-sm">
        <div>
          <div className="text-xs text-muted">Patient</div>
          <div className="font-medium">{inv.patient_name}</div>
          <div className="text-xs text-muted">
            {inv.uhid}
            {p?.date_of_birth ? ` · ${formatAge(p.date_of_birth, p.dob_estimated)}` : ""}
            {p?.gender ? ` · ${p.gender}` : ""}
          </div>
        </div>
        <div className="text-right">
          {inv.due_date && inv.balance > 0 && (
            <>
              <div className="text-xs text-muted">Due by</div>
              <div className="font-medium">{formatDateOnly(inv.due_date)}</div>
            </>
          )}
        </div>
      </div>

      <table className="w-full text-sm">
        <thead className="border-b border-border text-left text-xs tracking-wide text-muted uppercase">
          <tr>
            <th className="py-2 font-medium">Description</th>
            <th className="py-2 text-right font-medium">Qty</th>
            <th className="py-2 text-right font-medium">Rate</th>
            <th className="py-2 text-right font-medium">Amount</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {inv.lines.map((l) => (
            <tr key={l.line_id}>
              <td className="py-2">{l.description}</td>
              <td className="num py-2 text-right">{l.quantity}</td>
              <td className="num py-2 text-right">{inr(l.unit_price)}</td>
              <td className="num py-2 text-right">{inr(l.line_total)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <dl className="mt-4 ml-auto w-64 space-y-1 text-sm">
        <div className="flex justify-between"><dt className="text-muted">Subtotal</dt><dd className="num">{inr(inv.subtotal)}</dd></div>
        {inv.discount_amount > 0 && <div className="flex justify-between"><dt className="text-muted">Discount</dt><dd className="num">−{inr(inv.discount_amount)}</dd></div>}
        {inv.tax_amount > 0 && <div className="flex justify-between"><dt className="text-muted">GST</dt><dd className="num">{inr(inv.tax_amount)}</dd></div>}
        <div className="flex justify-between border-t border-border pt-1 text-base font-semibold"><dt>Total</dt><dd className="num">{inr(inv.total)}</dd></div>
        {inv.payments.filter((x) => x.kind === "payment").map((x) => (
          <div key={x.payment_id} className="flex justify-between text-xs text-muted">
            <dt>{formatDateTime(x.received_at)} · {METHOD_LABEL[x.method]} · {x.receipt_number}</dt>
            <dd className="num">{inr(x.amount)}</dd>
          </div>
        ))}
        {inv.payments.filter((x) => x.kind === "refund").map((x) => (
          <div key={x.payment_id} className="flex justify-between text-xs text-muted">
            <dt>Refund · {x.receipt_number}</dt>
            <dd className="num">−{inr(x.amount)}</dd>
          </div>
        ))}
        <div className="flex justify-between font-semibold"><dt>Balance due</dt><dd className="num">{inr(inv.balance)}</dd></div>
      </dl>

      <div className="mt-8 flex items-center justify-between text-xs text-muted">
        <span>Thank you for choosing {e.HOSPITAL_NAME}.</span>
        <PrintButton />
      </div>
    </div>
  );
}
