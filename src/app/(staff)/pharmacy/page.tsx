import Link from "next/link";
import { connection } from "next/server";
import { AutoRefresh } from "@/components/client";
import { Badge, Card, Empty, PageHeader, Stat } from "@/components/ui";
import { formatAge } from "@/lib/age";
import { pool } from "@/lib/db";
import { formatDateTime } from "@/lib/time";
import { requireStaff } from "@/server/auth/guard";
import { pharmacyQueue } from "@/server/pharmacy/dispense";
import { stockOverview } from "@/server/pharmacy/stock";

export const metadata = { title: "Pharmacy" };

export default async function PharmacyPage() {
  await connection();
  await requireStaff("pharmacy.dispense");
  const [queue, stock] = await Promise.all([pharmacyQueue(pool()), stockOverview(pool())]);

  const low = stock.filter((s) => s.status === "low").length;
  const out = stock.filter((s) => s.status === "out").length;
  const expiring = stock.filter((s) => s.expiring_soon > 0).length;
  const expired = stock.filter((s) => s.expired > 0).length;

  return (
    <>
      <AutoRefresh seconds={8} />
      <PageHeader
        title="Pharmacy"
        description="Prescriptions waiting at the counter, oldest first."
        actions={
          <Link href="/pharmacy/stock" className="rounded-lg border border-border px-3 py-2 text-sm hover:border-primary hover:text-primary">
            Stock and receiving
          </Link>
        }
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Waiting" value={queue.length} tone={queue.length ? "warn" : "neutral"} hint="prescriptions to fill" />
        <Stat label="Low stock" value={low} tone={low ? "warn" : "neutral"} hint={`${out} out of stock`} href="/pharmacy/stock?view=low" />
        <Stat label="Expiring soon" value={expiring} tone={expiring ? "warn" : "neutral"} hint="within 60 days" href="/pharmacy/stock?view=expiring" />
        <Stat label="Expired on shelf" value={expired} tone={expired ? "danger" : "neutral"} hint="to write off" href="/pharmacy/stock?view=expired" />
      </div>

      <Card title="Prescriptions" className="mt-6">
        {queue.length === 0 ? (
          <Empty>Nothing waiting. New prescriptions appear here the moment a doctor finishes a consultation.</Empty>
        ) : (
          <ul className="divide-y divide-border">
            {queue.map((q) => (
              <li key={q.prescription_id}>
                <Link href={`/pharmacy/${q.prescription_id}`} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 hover:bg-surface-2">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2 font-medium">
                      {q.patient_name}
                      {q.status === "partially_dispensed" && <Badge tone="info">Part given</Badge>}
                      {q.allergy_override_reason && <Badge tone="danger">Allergy reviewed</Badge>}
                    </div>
                    <div className="text-xs text-muted">
                      {q.uhid} · {formatAge(q.date_of_birth, q.dob_estimated)} · {q.doctor_name} · {formatDateTime(q.issued_at)}
                    </div>
                    {q.allergies && <div className="text-xs text-danger">Allergy: {q.allergies}</div>}
                  </div>
                  <div className="text-right text-sm">
                    <div className="num font-medium">
                      {q.outstanding} of {q.items} item{q.items === 1 ? "" : "s"} to fill
                    </div>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
