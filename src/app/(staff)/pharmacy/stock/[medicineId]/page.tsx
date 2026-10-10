import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Badge, Card, Empty, PageHeader, Td, Th } from "@/components/ui";
import { one, pool } from "@/lib/db";
import { formatDateOnly, formatDateTime } from "@/lib/time";
import { requireStaff } from "@/server/auth/guard";
import { listBatches, stockMovements } from "@/server/pharmacy/stock";
import { AdjustForm, ReceiveForm, ReorderForm } from "../forms";

export const metadata = { title: "Medicine stock" };

export default async function MedicineStockPage({ params }: { params: Promise<{ medicineId: string }> }) {
  await connection();
  await requireStaff("pharmacy.stock");
  const { medicineId } = await params;
  const med = await one<{ medicine_id: string; name: string; generic_name: string; form: string; reorder_level: number }>(
    pool(),
    `SELECT medicine_id, name, generic_name, form, reorder_level FROM medicines WHERE medicine_id = $1`,
    [medicineId],
  );
  if (!med) notFound();

  const [batches, movements] = await Promise.all([listBatches(pool(), medicineId), stockMovements(pool(), medicineId)]);

  return (
    <>
      <PageHeader
        title={med.name}
        description={`${med.generic_name} · ${med.form}`}
        actions={
          <Link href="/pharmacy/stock" className="text-sm text-muted hover:text-text">
            All stock
          </Link>
        }
      />

      <div className="grid gap-6 xl:grid-cols-3">
        <div className="space-y-6 xl:col-span-2">
          <Card title="Batches">
            {batches.length === 0 ? (
              <Empty>No stock has been received for this medicine.</Empty>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead className="border-b border-border">
                    <tr>
                      <Th>Batch</Th>
                      <Th>Expiry</Th>
                      <Th>On hand</Th>
                      <Th>Price</Th>
                      <Th>Correct</Th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {batches.map((b) => (
                      <tr key={b.batch_id} className={b.quantity_on_hand === 0 ? "opacity-60" : ""}>
                        <Td>
                          <div className="font-medium">{b.batch_number}</div>
                          {b.supplier && <div className="text-xs text-muted">{b.supplier}</div>}
                        </Td>
                        <Td className="num whitespace-nowrap">
                          {formatDateOnly(b.expiry_date).split(", ").slice(1).join(", ")}
                          {b.expired && <div><Badge tone="danger">Expired</Badge></div>}
                        </Td>
                        <Td className="num">
                          {b.quantity_on_hand}
                          <span className="text-xs text-muted"> / {b.quantity_received}</span>
                        </Td>
                        <Td className="num">₹{b.unit_price.toFixed(2)}</Td>
                        <Td>{b.quantity_on_hand > 0 && <AdjustForm batchId={b.batch_id} onHand={b.quantity_on_hand} />}</Td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <Card title="Receive a delivery of this medicine">
            <ReceiveForm medicines={[]} fixedMedicineId={med.medicine_id} />
          </Card>
        </div>

        <div className="space-y-6">
          <Card title="Reorder level">
            <div className="p-4">
              <ReorderForm medicineId={med.medicine_id} level={med.reorder_level} />
            </div>
          </Card>
          <Card title="Recent movements">
            {movements.length === 0 ? (
              <Empty>None yet.</Empty>
            ) : (
              <ul className="divide-y divide-border text-sm">
                {movements.map((m) => (
                  <li key={m.movement_id} className="flex justify-between gap-3 px-4 py-2.5">
                    <div className="min-w-0">
                      <div className="capitalize">
                        {m.kind.replace("_", " ")} · {m.batch_number}
                      </div>
                      <div className="truncate text-xs text-muted">
                        {formatDateTime(m.created_at)}
                        {m.actor ? ` · ${m.actor}` : ""}
                        {m.reference && m.kind !== "dispense" ? ` · ${m.reference}` : ""}
                      </div>
                    </div>
                    <span className={`num shrink-0 font-medium ${m.quantity < 0 ? "text-danger" : "text-ok"}`}>
                      {m.quantity > 0 ? `+${m.quantity}` : m.quantity}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}
