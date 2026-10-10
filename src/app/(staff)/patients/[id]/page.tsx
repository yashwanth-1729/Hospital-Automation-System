import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Badge, Card, Empty, PageHeader, Td, Th } from "@/components/ui";
import { formatAge } from "@/lib/age";
import { many, pool } from "@/lib/db";
import { describeItem } from "@/lib/prescribing";
import { can } from "@/lib/rbac";
import { formatDateOnly, formatSlot } from "@/lib/time";
import { requireStaff } from "@/server/auth/guard";
import { patientHistory } from "@/server/clinic/consultation";
import { getPatient } from "@/server/clinic/patients";

export const metadata = { title: "Patient record" };

const STATUS_TONE = { waiting: "warn", in_consultation: "info", completed: "ok", cancelled: "neutral" } as const;
const STATUS_LABEL = { waiting: "Waiting", in_consultation: "With doctor", completed: "Seen", cancelled: "Left" } as const;

export default async function PatientPage({ params }: { params: Promise<{ id: string }> }) {
  await connection();
  const user = await requireStaff("patients.view");
  const { id } = await params;
  const patient = await getPatient(pool(), id);
  if (!patient) notFound();

  const clinical = can(user.role, "records.view");
  const [visits, upcoming, history] = await Promise.all([
    many<{ visit_id: string; visit_date: string; token_number: number; status: keyof typeof STATUS_LABEL; doctor_name: string; department: string; reason: string | null }>(
      pool(),
      `SELECT v.visit_id, v.visit_date, v.token_number, v.status, d.full_name AS doctor_name, dep.name AS department, v.reason
         FROM visits v JOIN doctors d ON d.doctor_id = v.doctor_id JOIN departments dep ON dep.department_id = v.department_id
        WHERE v.patient_id = $1 ORDER BY v.visit_date DESC, v.token_number DESC LIMIT 30`,
      [id],
    ),
    many<{ appointment_id: string; slot_start: Date; doctor_name: string; department: string }>(
      pool(),
      `SELECT a.appointment_id, a.slot_start, d.full_name AS doctor_name, dep.name AS department
         FROM appointments a JOIN doctors d ON d.doctor_id = a.doctor_id JOIN departments dep ON dep.department_id = a.department_id
        WHERE a.patient_id = $1 AND a.status = 'booked' AND a.slot_start > now() ORDER BY a.slot_start LIMIT 5`,
      [id],
    ),
    clinical ? patientHistory(pool(), id, { limit: 20 }) : Promise.resolve([]),
  ]);

  const details: [string, string | null][] = [
    ["Mobile", patient.phone],
    ["City", patient.city],
    ["Address", patient.address],
    ["Blood group", patient.blood_group],
    ["Insurance", [patient.insurance_provider, patient.insurance_policy_no].filter(Boolean).join(" · ") || null],
    ["Emergency contact", [patient.emergency_contact_name, patient.emergency_contact_phone].filter(Boolean).join(" · ") || null],
    ["WhatsApp updates", patient.consent_status === "granted" ? "Agreed" : patient.consent_status === "denied" ? "Declined" : "Not asked"],
  ];

  return (
    <>
      <PageHeader
        title={patient.full_name}
        description={`${patient.uhid} · ${formatAge(patient.date_of_birth, patient.dob_estimated)}${patient.gender ? ` · ${patient.gender}` : ""}`}
        actions={
          <Link href="/reception" className="text-sm text-muted hover:text-text">
            Back to reception
          </Link>
        }
      />

      <p className={`mb-6 rounded-lg px-4 py-2 text-sm ${patient.allergies ? "bg-danger-soft text-danger" : "bg-surface-2 text-muted"}`}>
        {patient.allergies ? `Allergy: ${patient.allergies}` : "No allergies recorded."}
      </p>

      <div className="grid gap-6 xl:grid-cols-3">
        <div className="space-y-6 xl:col-span-2">
          {clinical && (
            <Card title="Consultations">
              {history.length === 0 ? (
                <Empty>No finished consultations yet.</Empty>
              ) : (
                <ul className="divide-y divide-border">
                  {history.map((h) => (
                    <li key={h.consultation_id} className="space-y-1 px-4 py-3 text-sm">
                      <div className="flex flex-wrap justify-between gap-2">
                        <span className="font-medium">{h.diagnosis}</span>
                        <span className="text-xs text-muted">
                          {formatDateOnly(h.visit_date)} · {h.doctor_name}
                        </span>
                      </div>
                      {h.chief_complaint && <div className="text-xs text-muted">{h.chief_complaint}</div>}
                      {h.items.length > 0 && (
                        <ul className="list-inside list-disc text-xs text-muted">
                          {h.items.map((i) => (
                            <li key={i.item_id}>{describeItem({ ...i, unit: i.unit ?? undefined })}</li>
                          ))}
                        </ul>
                      )}
                      {h.addenda.map((a, i) => (
                        <p key={i} className="rounded bg-surface-2 px-2 py-1 text-xs">
                          Later note ({a.author}): {a.note}
                        </p>
                      ))}
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          )}

          <Card title="Visits">
            {visits.length === 0 ? (
              <Empty>No visits yet.</Empty>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead className="border-b border-border">
                    <tr>
                      <Th>Date</Th>
                      <Th>Doctor</Th>
                      <Th>Token</Th>
                      <Th>Status</Th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {visits.map((v) => (
                      <tr key={v.visit_id}>
                        <Td className="num whitespace-nowrap">{formatDateOnly(v.visit_date)}</Td>
                        <Td>
                          {v.doctor_name}
                          <div className="text-xs text-muted">{v.department}{v.reason ? ` · ${v.reason}` : ""}</div>
                        </Td>
                        <Td className="num">{v.token_number}</Td>
                        <Td><Badge tone={STATUS_TONE[v.status]}>{STATUS_LABEL[v.status]}</Badge></Td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </div>

        <div className="space-y-6">
          <Card title="Details">
            <dl className="divide-y divide-border text-sm">
              {details.map(([label, value]) => (
                <div key={label} className="flex justify-between gap-4 px-4 py-2.5">
                  <dt className="text-muted">{label}</dt>
                  <dd className="text-right font-medium">{value ?? "—"}</dd>
                </div>
              ))}
            </dl>
          </Card>
          <Card title="Upcoming appointments">
            {upcoming.length === 0 ? (
              <Empty>None booked.</Empty>
            ) : (
              <ul className="divide-y divide-border text-sm">
                {upcoming.map((a) => (
                  <li key={a.appointment_id} className="px-4 py-3">
                    <div className="font-medium">{formatSlot(a.slot_start)}</div>
                    <div className="text-xs text-muted">{a.doctor_name} · {a.department}</div>
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
