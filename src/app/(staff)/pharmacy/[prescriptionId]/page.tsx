import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Badge, Card, PageHeader } from "@/components/ui";
import { formatAge } from "@/lib/age";
import { many, pool } from "@/lib/db";
import { allergyConflicts, FREQUENCIES, TIMINGS } from "@/lib/prescribing";
import { formatDateOnly, formatDateTime } from "@/lib/time";
import { requireStaff } from "@/server/auth/guard";
import { alternativesFor, getPrescription } from "@/server/pharmacy/dispense";
import { CloseForm, DispenseForm, LinkItemForm } from "./forms";

export const metadata = { title: "Dispense" };

const STATUS_LABEL: Record<string, string> = {
  issued: "Ready to fill",
  partially_dispensed: "Part given",
  dispensed: "Dispensed",
  cancelled: "Closed unfilled",
};

export default async function DispensePage({ params }: { params: Promise<{ prescriptionId: string }> }) {
  await connection();
  await requireStaff("pharmacy.dispense");
  const { prescriptionId } = await params;
  const rx = await getPrescription(pool(), prescriptionId);
  if (!rx) notFound();

  const open = rx.status === "issued" || rx.status === "partially_dispensed";
  const conflicts = allergyConflicts(rx.allergies, rx.items.map((i) => ({ medicine_name: i.medicine_name, generic_name: i.generic_name })));
  const flagged = new Map(conflicts.map((c) => [c.index, c.allergen]));
  const alts = new Map<string, Awaited<ReturnType<typeof alternativesFor>>>();
  if (open) {
    for (const i of rx.items) {
      if (i.medicine_id && i.dispensed_qty === 0 && i.available < i.quantity) alts.set(i.item_id, await alternativesFor(pool(), i.medicine_id));
    }
  }
  const unlinked = rx.items.filter((i) => !i.medicine_id && i.dispensed_qty < i.quantity);
  const formulary = unlinked.length
    ? await many<{ medicine_id: string; name: string }>(pool(), `SELECT medicine_id, name FROM medicines WHERE active ORDER BY name`)
    : [];

  return (
    <>
      <PageHeader
        title={rx.patient_name}
        description={`${rx.uhid} · ${formatAge(rx.date_of_birth, rx.dob_estimated)}${rx.gender ? ` · ${rx.gender}` : ""} · ${rx.doctor_name}, ${rx.department}`}
        actions={
          <Link href="/pharmacy" className="text-sm text-muted hover:text-text">
            Back to queue
          </Link>
        }
      />

      <div className="mb-6 space-y-2">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <Badge tone={rx.status === "dispensed" ? "ok" : rx.status === "cancelled" ? "neutral" : "warn"}>{STATUS_LABEL[rx.status] ?? rx.status}</Badge>
          {rx.issued_at && <span className="text-muted">Issued {formatDateTime(rx.issued_at)}</span>}
          {rx.diagnosis && <span className="text-muted">· {rx.diagnosis}</span>}
        </div>
        <p className={`rounded-lg px-4 py-2 text-sm ${rx.allergies ? "bg-danger-soft text-danger" : "bg-surface-2 text-muted"}`}>
          {rx.allergies ? `Allergy: ${rx.allergies}` : "No allergies recorded."}
        </p>
        {rx.allergy_override_reason && (
          <p className="rounded-lg bg-warn-soft px-4 py-2 text-sm text-warn">
            The doctor prescribed against a recorded allergy and gave this reason: {rx.allergy_override_reason}
          </p>
        )}
        {rx.pharmacy_note && <p className="rounded-lg bg-surface-2 px-4 py-2 text-sm">Pharmacy note: {rx.pharmacy_note}</p>}
      </div>

      <Card title="Items">
        <div className="p-4">
          {open ? (
            <DispenseForm
              key={rx.items.map((i) => `${i.item_id}:${i.medicine_id}:${i.available}:${i.dispensed_qty}`).join("|")}
              prescriptionId={rx.prescription_id}
              items={rx.items.map((i, index) => ({
                item_id: i.item_id,
                name: i.medicine_name,
                sig: `${i.dose_units}${i.unit && i.unit !== "unit" ? ` ${i.unit}` : ""}, ${FREQUENCIES[i.frequency].label.toLowerCase()}, ${i.duration_days} day${i.duration_days === 1 ? "" : "s"}${i.timing === "any" ? "" : `, ${TIMINGS[i.timing].toLowerCase()}`}`,
                instructions: i.instructions,
                outstanding: i.quantity - i.dispensed_qty,
                given: i.dispensed_qty,
                prescribed: i.quantity,
                available: i.available,
                unit_price: i.unit_price,
                next_expiry: i.next_expiry ? formatDateOnly(i.next_expiry) : null,
                linked: !!i.medicine_id,
                allergen: flagged.get(index) ?? null,
                alternatives: alts.get(i.item_id) ?? [],
              }))}
            />
          ) : (
            <ul className="divide-y divide-border text-sm">
              {rx.items.map((i) => (
                <li key={i.item_id} className="flex justify-between gap-3 py-2">
                  <span>{i.medicine_name}</span>
                  <span className="num text-muted">
                    {i.dispensed_qty} of {i.quantity} given
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Card>

      {open && unlinked.length > 0 && (
        <Card title="Match to the formulary" className="mt-6">
          <div className="space-y-3 p-4">
            <p className="text-sm text-muted">The doctor wrote a name that is not in the formulary. Say which product it is, so stock can be taken.</p>
            {unlinked.map((i) => (
              <LinkItemForm key={i.item_id} prescriptionId={rx.prescription_id} itemId={i.item_id} label={i.medicine_name} options={formulary} />
            ))}
          </div>
        </Card>
      )}

      {rx.dispensations.length > 0 && (
        <Card title="Dispensed so far" className="mt-6">
          <ul className="divide-y divide-border text-sm">
            {rx.dispensations.map((d) => (
              <li key={d.dispensation_id} className="flex justify-between gap-3 px-4 py-2.5">
                <span>
                  {formatDateTime(d.dispensed_at)} · {d.by}
                </span>
                <span className="num font-medium">₹{d.total.toFixed(2)}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {open && (
        <Card title="Cannot fill everything?" className="mt-6">
          <div className="p-4">
            <CloseForm prescriptionId={rx.prescription_id} />
          </div>
        </Card>
      )}
    </>
  );
}
