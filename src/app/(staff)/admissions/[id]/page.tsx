import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Badge, Card, PageHeader } from "@/components/ui";
import { formatAge } from "@/lib/age";
import { stayDays } from "@/lib/bed-days";
import { many, pool } from "@/lib/db";
import { can } from "@/lib/rbac";
import { formatDateOnly, formatDateTime } from "@/lib/time";
import { requireStaff } from "@/server/auth/guard";
import { listActiveDoctors } from "@/server/clinic/directory";
import { availableBeds, getAdmission } from "@/server/ipd/admissions";
import { billAdmissionAction } from "../../wards/actions";
import { DischargeForm, TransferForm } from "./forms";

export const metadata = { title: "Admission" };

export default async function AdmissionPage({ params }: { params: Promise<{ id: string }> }) {
  await connection();
  const user = await requireStaff("ipd.view");
  const { id } = await params;
  const adm = await getAdmission(pool(), id);
  if (!adm) notFound();

  const active = adm.status === "admitted";
  const [beds, doctors, invoice] = await Promise.all([
    active && can(user.role, "ipd.transfer") ? availableBeds(pool()) : Promise.resolve([]),
    active && can(user.role, "ipd.discharge") ? listActiveDoctors(pool()) : Promise.resolve([]),
    many<{ invoice_id: string; invoice_number: string | null; status: string }>(
      pool(),
      `SELECT invoice_id, invoice_number, status FROM invoices WHERE admission_id = $1 AND status <> 'void' ORDER BY created_at`,
      [id],
    ),
  ]);

  const totalDays = adm.stays.reduce((n, s) => n + stayDays({ startedAt: s.started_at, endedAt: s.ended_at, endedReason: s.ended_reason }), 0);

  return (
    <>
      <PageHeader
        title={adm.patient_name}
        description={`${adm.uhid} · ${formatAge(adm.date_of_birth, adm.dob_estimated)} · ${adm.doctor_name}, ${adm.department}`}
        actions={
          <Link href="/wards" className="text-sm text-muted hover:text-text">
            Back to wards
          </Link>
        }
      />

      <div className="mb-6 space-y-2">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <Badge tone={active ? "primary" : "neutral"}>{active ? "Admitted" : "Discharged"}</Badge>
          <span className="text-muted">Admitted {formatDateTime(adm.admitted_at)}</span>
          {adm.discharged_at && <span className="text-muted">· Discharged {formatDateTime(adm.discharged_at)}</span>}
          {adm.expected_discharge && active && <span className="text-muted">· Expected {formatDateOnly(adm.expected_discharge)}</span>}
        </div>
        {adm.reason && <p className="text-sm">{adm.reason}</p>}
        {adm.allergies && <p className="rounded-lg bg-danger-soft px-4 py-2 text-sm text-danger">Allergy: {adm.allergies}</p>}
      </div>

      <div className="grid gap-6 xl:grid-cols-3">
        <div className="space-y-6 xl:col-span-2">
          <Card title="Beds occupied" action={<span className="text-xs text-muted">{totalDays} chargeable day{totalDays === 1 ? "" : "s"}</span>}>
            <ul className="divide-y divide-border text-sm">
              {adm.stays.map((s) => {
                const days = stayDays({ startedAt: s.started_at, endedAt: s.ended_at, endedReason: s.ended_reason });
                return (
                  <li key={s.stay_id} className="flex flex-wrap justify-between gap-3 px-4 py-3">
                    <div>
                      <div className="font-medium">
                        {s.ward_name} · {s.bed_label}
                      </div>
                      <div className="text-xs text-muted">
                        {formatDateTime(s.started_at)} → {s.ended_at ? formatDateTime(s.ended_at) : "now"}
                        {s.ended_reason === "transfer" ? " (moved)" : ""}
                      </div>
                    </div>
                    <div className="num text-right">
                      <div>{days} day{days === 1 ? "" : "s"} × ₹{s.daily_rate.toLocaleString("en-IN")}</div>
                    </div>
                  </li>
                );
              })}
            </ul>
          </Card>

          {active && can(user.role, "ipd.transfer") && (
            <Card title="Move to another bed">
              <div className="p-4">
                <TransferForm admissionId={adm.admission_id} beds={beds} />
              </div>
            </Card>
          )}
        </div>

        <div className="space-y-6">
          {active && can(user.role, "ipd.discharge") && (
            <Card title="Discharge">
              <div className="p-4">
                <DischargeForm admissionId={adm.admission_id} doctors={doctors} defaultApprover={adm.doctor_name} />
              </div>
            </Card>
          )}

          {!active && (
            <Card title="After discharge">
              <div className="space-y-3 p-4 text-sm">
                <p className="text-muted">The follow-up reminder and feedback request are handled automatically.</p>
                <Link href="/discharges" className="block text-primary underline">
                  See the discharge follow-up
                </Link>
                {can(user.role, "billing.manage") && (
                  <div className="border-t border-border pt-3">
                    {invoice.length > 0 ? (
                      invoice.map((i) => (
                        <Link key={i.invoice_id} href={`/billing/${i.invoice_id}`} className="block text-primary underline">
                          Invoice {i.invoice_number ?? "(draft)"}
                        </Link>
                      ))
                    ) : null}
                    <form action={billAdmissionAction} className="mt-2">
                      <input type="hidden" name="admission_id" value={adm.admission_id} />
                      <button className="rounded-lg border border-primary px-3 py-1.5 text-sm font-medium text-primary hover:bg-primary-soft">
                        {invoice.length > 0 ? "Add unbilled bed charges" : "Create invoice for the stay"}
                      </button>
                    </form>
                  </div>
                )}
              </div>
            </Card>
          )}
        </div>
      </div>
    </>
  );
}
