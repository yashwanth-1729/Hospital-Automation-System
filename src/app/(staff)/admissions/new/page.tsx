import Link from "next/link";
import { connection } from "next/server";
import { Card, Empty, PageHeader } from "@/components/ui";
import { formatAge } from "@/lib/age";
import { pool } from "@/lib/db";
import { requireStaff } from "@/server/auth/guard";
import { listActiveDoctors } from "@/server/clinic/directory";
import { getPatient, searchPatients } from "@/server/clinic/patients";
import { availableBeds } from "@/server/ipd/admissions";
import { AdmitForm } from "./form";

export const metadata = { title: "Admit a patient" };

export default async function AdmitPage({ searchParams }: { searchParams: Promise<{ q?: string; patient?: string; bed?: string }> }) {
  await connection();
  await requireStaff("ipd.admit");
  const { q = "", patient: patientId, bed } = await searchParams;

  const [selected, beds, doctors, results] = await Promise.all([
    patientId ? getPatient(pool(), patientId) : Promise.resolve(undefined),
    availableBeds(pool()),
    listActiveDoctors(pool()),
    !patientId && q.trim() ? searchPatients(pool(), q, 8) : Promise.resolve([]),
  ]);

  return (
    <>
      <PageHeader
        title="Admit a patient"
        actions={
          <Link href="/wards" className="text-sm text-muted hover:text-text">
            Back to wards
          </Link>
        }
      />

      {!selected ? (
        <Card title="Who is being admitted?" className="max-w-2xl">
          <form action="/admissions/new" className="border-b border-border p-4">
            {bed && <input type="hidden" name="bed" value={bed} />}
            <input
              name="q"
              defaultValue={q}
              autoFocus
              placeholder="Name, UHID or mobile number"
              aria-label="Search patients"
              className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-primary"
            />
          </form>
          {q.trim() && results.length === 0 && (
            <Empty>
              No patient matches. <Link href="/reception/register" className="text-primary underline">Register them first</Link>.
            </Empty>
          )}
          <ul className="divide-y divide-border">
            {results.map((p) => (
              <li key={p.patient_id}>
                <Link
                  href={`/admissions/new?patient=${p.patient_id}${bed ? `&bed=${bed}` : ""}`}
                  className="flex items-center justify-between gap-3 px-4 py-3 hover:bg-surface-2"
                >
                  <div>
                    <div className="text-sm font-medium">{p.full_name}</div>
                    <div className="text-xs text-muted">
                      {p.uhid} · {formatAge(p.date_of_birth, p.dob_estimated)}
                      {p.gender ? ` · ${p.gender}` : ""}
                    </div>
                  </div>
                  <span className="text-xs text-primary">Select</span>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      ) : (
        <Card title={`${selected.full_name} · ${selected.uhid}`} className="max-w-2xl">
          <div className="p-4">
            {selected.allergies && <p className="mb-4 rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">Allergy: {selected.allergies}</p>}
            {beds.length === 0 ? (
              <p className="text-sm text-warn">There are no free beds right now.</p>
            ) : (
              <AdmitForm patientId={selected.patient_id} beds={beds} doctors={doctors} initialBed={bed} />
            )}
          </div>
        </Card>
      )}
    </>
  );
}
