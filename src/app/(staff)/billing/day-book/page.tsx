import Link from "next/link";
import { connection } from "next/server";
import { Badge, Card, Empty, PageHeader, Stat, Td, Th } from "@/components/ui";
import { many, pool } from "@/lib/db";
import { addDays, formatDateOnly, formatDateTime, isValidDateString, istAt, istDateString } from "@/lib/time";
import { requireStaff } from "@/server/auth/guard";
import { daySummary, METHOD_LABEL, type PaymentMethod } from "@/server/billing/invoices";
import { inr } from "../status";

export const metadata = { title: "Day book" };

export default async function DayBookPage({ searchParams }: { searchParams: Promise<{ date?: string }> }) {
  await connection();
  await requireStaff("billing.manage");
  const { date: raw } = await searchParams;
  const today = istDateString();
  const date = raw && isValidDateString(raw) && raw <= today ? raw : today;

  const [summary, rows] = await Promise.all([
    daySummary(pool(), date),
    many<{ payment_id: string; kind: string; amount: number; method: PaymentMethod; receipt_number: string; received_at: Date; invoice_id: string; invoice_number: string; patient_name: string; by: string }>(
      pool(),
      `SELECT pay.payment_id, pay.kind, pay.amount::float AS amount, pay.method, pay.receipt_number, pay.received_at,
              i.invoice_id, i.invoice_number, p.full_name AS patient_name, u.full_name AS by
         FROM payments pay
         JOIN invoices i ON i.invoice_id = pay.invoice_id
         JOIN patients p ON p.patient_id = i.patient_id
         JOIN staff_users u ON u.user_id = pay.received_by
        WHERE pay.received_at >= $1 AND pay.received_at < $2
        ORDER BY pay.received_at`,
      [istAt(date, 0), istAt(addDays(date, 1), 0)],
    ),
  ]);

  return (
    <>
      <PageHeader
        title="Day book"
        description={formatDateOnly(date)}
        actions={
          <div className="flex items-center gap-3 text-sm">
            <Link href={`/billing/day-book?date=${addDays(date, -1)}`} className="text-muted hover:text-text">← Previous day</Link>
            {date < today && <Link href={`/billing/day-book?date=${addDays(date, 1)}`} className="text-muted hover:text-text">Next day →</Link>}
            <Link href="/billing" className="text-muted hover:text-text">Back to billing</Link>
          </div>
        }
      />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Collected" value={inr(summary.collected)} tone="ok" />
        <Stat label="Refunded" value={inr(summary.refunded)} tone={summary.refunded ? "warn" : "neutral"} />
        <Stat label="Net" value={inr(summary.net)} />
        <Stat label="Invoices issued" value={summary.invoices_issued} hint={inr(summary.billed)} />
      </div>

      {summary.by_method.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {summary.by_method.map((m) => (
            <Badge key={m.method} tone="primary">
              {METHOD_LABEL[m.method]} {inr(m.amount)} · {m.count}
            </Badge>
          ))}
        </div>
      )}

      <Card title="Receipts" className="mt-6">
        {rows.length === 0 ? (
          <Empty>No money moved on this day.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="border-b border-border">
                <tr>
                  <Th>Time</Th>
                  <Th>Receipt</Th>
                  <Th>Patient</Th>
                  <Th>Method</Th>
                  <Th>Received by</Th>
                  <Th className="text-right">Amount</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {rows.map((r) => (
                  <tr key={r.payment_id}>
                    <Td className="num whitespace-nowrap">{formatDateTime(r.received_at).split(", ")[1]}</Td>
                    <Td>
                      <span className="num">{r.receipt_number}</span>
                      <div className="text-xs">
                        <Link href={`/billing/${r.invoice_id}`} className="text-muted hover:text-primary">{r.invoice_number}</Link>
                      </div>
                    </Td>
                    <Td>{r.patient_name}</Td>
                    <Td>{METHOD_LABEL[r.method]}</Td>
                    <Td className="text-muted">{r.by}</Td>
                    <Td className={`num text-right font-medium ${r.kind === "refund" ? "text-danger" : ""}`}>
                      {r.kind === "refund" ? "−" : ""}
                      {inr(r.amount)}
                    </Td>
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
