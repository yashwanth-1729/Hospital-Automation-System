import Link from "next/link";
import { connection } from "next/server";
import { AutoRefresh } from "@/components/client";
import { Badge, Card, Empty, PageHeader, Stat } from "@/components/ui";
import { formatAge } from "@/lib/age";
import { pool } from "@/lib/db";
import { can } from "@/lib/rbac";
import { formatDateTime } from "@/lib/time";
import { requireStaff } from "@/server/auth/guard";
import { bedBoard, listAdmissions } from "@/server/ipd/admissions";
import { AddWardForm, BedButton } from "./controls";

export const metadata = { title: "Wards" };

const TILE: Record<string, string> = {
  available: "border-ok/40 bg-ok-soft",
  occupied: "border-primary/40 bg-primary-soft",
  cleaning: "border-warn/40 bg-warn-soft",
  maintenance: "border-border bg-surface-2",
};
const LABEL: Record<string, string> = { available: "Available", occupied: "Occupied", cleaning: "Cleaning", maintenance: "Maintenance" };
const KIND: Record<string, string> = { general: "General", semi_private: "Semi-private", private: "Private", icu: "Intensive care", day_care: "Day care" };

export default async function WardsPage() {
  await connection();
  const user = await requireStaff("ipd.view");
  const [board, current] = await Promise.all([bedBoard(pool()), listAdmissions(pool(), { status: "admitted" })]);

  const beds = board.flatMap((w) => w.beds);
  const count = (s: string) => beds.filter((b) => b.status === s).length;
  const canAdmit = can(user.role, "ipd.admit");
  const canBeds = can(user.role, "ipd.beds");

  return (
    <>
      <AutoRefresh seconds={15} />
      <PageHeader
        title="Wards"
        description="Every bed and who is in it."
        actions={
          canAdmit && (
            <Link href="/admissions/new" className="rounded-lg bg-primary px-3 py-2 text-sm font-medium text-white hover:opacity-90">
              Admit a patient
            </Link>
          )
        }
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Occupied" value={`${count("occupied")} / ${beds.length}`} tone="info" hint={beds.length ? `${Math.round((count("occupied") / beds.length) * 100)}% occupancy` : ""} />
        <Stat label="Available" value={count("available")} tone="ok" />
        <Stat label="Being cleaned" value={count("cleaning")} tone={count("cleaning") ? "warn" : "neutral"} />
        <Stat label="Maintenance" value={count("maintenance")} />
      </div>

      <div className="mt-6 space-y-6">
        {board.length === 0 && (
          <Card>
            <Empty>No wards have been set up yet.</Empty>
          </Card>
        )}
        {board.map((w) => (
          <Card
            key={w.ward_id}
            title={`${w.name}`}
            action={
              <span className="text-xs text-muted">
                {KIND[w.kind]} · ₹{w.daily_rate.toLocaleString("en-IN")}/day
              </span>
            }
          >
            <div className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
              {w.beds.map((b) => (
                <div key={b.bed_id} className={`rounded-lg border p-3 transition-shadow hover:shadow-sm ${TILE[b.status]}`}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="num text-sm font-semibold">{b.label}</span>
                    <span className="text-xs text-muted">{LABEL[b.status]}</span>
                  </div>
                  {b.status === "occupied" && b.admission_id ? (
                    <Link href={`/admissions/${b.admission_id}`} className="mt-2 block">
                      <div className="truncate text-sm font-medium hover:text-primary">{b.patient_name}</div>
                      <div className="text-xs text-muted">
                        {formatAge(b.date_of_birth, b.dob_estimated ?? false)} · {b.doctor_name}
                      </div>
                      {b.admitted_at && <div className="text-xs text-muted">Since {formatDateTime(b.admitted_at)}</div>}
                    </Link>
                  ) : (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {b.status === "available" && canAdmit && (
                        <Link href={`/admissions/new?bed=${b.bed_id}`} className="rounded-md bg-primary px-2 py-0.5 text-xs font-medium text-white hover:opacity-90">
                          Admit here
                        </Link>
                      )}
                      {b.status === "cleaning" && canBeds && <BedButton bedId={b.bed_id} kind="ready" />}
                      {b.status === "available" && canBeds && <BedButton bedId={b.bed_id} kind="maintenance_on" />}
                      {b.status === "maintenance" && canBeds && <BedButton bedId={b.bed_id} kind="maintenance_off" />}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </Card>
        ))}
      </div>

      <Card title={`Current inpatients (${current.length})`} className="mt-6">
        {current.length === 0 ? (
          <Empty>Nobody is admitted.</Empty>
        ) : (
          <ul className="divide-y divide-border">
            {current.map((a) => (
              <li key={a.admission_id}>
                <Link href={`/admissions/${a.admission_id}`} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 hover:bg-surface-2">
                  <div className="min-w-0">
                    <div className="font-medium">{a.patient_name}</div>
                    <div className="text-xs text-muted">
                      {a.uhid} · {formatAge(a.date_of_birth, a.dob_estimated)} · {a.doctor_name}
                      {a.reason ? ` · ${a.reason}` : ""}
                    </div>
                    {a.allergies && <div className="text-xs text-danger">Allergy: {a.allergies}</div>}
                  </div>
                  <div className="text-right text-sm">
                    <Badge tone="primary">{a.ward_name} · {a.bed_label}</Badge>
                    <div className="mt-1 text-xs text-muted">Since {formatDateTime(a.admitted_at)}</div>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {can(user.role, "ipd.configure") && (
        <Card title="Add a ward" className="mt-6">
          <AddWardForm />
        </Card>
      )}
    </>
  );
}
