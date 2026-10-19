import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { connection } from "next/server";
import { Badge, Card, Empty, PageHeader } from "@/components/ui";
import { formatAge } from "@/lib/age";
import { many, one, pool } from "@/lib/db";
import { bmi, describeItem } from "@/lib/prescribing";
import { can } from "@/lib/rbac";
import { formatDateOnly, formatDateTime } from "@/lib/time";
import { requireStaff } from "@/server/auth/guard";
import { getConsultationForVisit, latestBody, patientHistory, visitVitals } from "@/server/clinic/consultation";
import { AddendumForm, ConsultForm, VitalsForm } from "./forms";
import { OrderForm, OrdersList } from "./imaging";
import { ordersForVisit, STUDY_CATALOGUE } from "@/server/radiology/imaging";

export const metadata = { title: "Consultation" };

interface VisitHeader {
  visit_id: string;
  status: string;
  token_number: number;
  reason: string | null;
  priority: string;
  doctor_id: string;
  doctor_name: string;
  department: string;
  patient_id: string;
  patient_name: string;
  uhid: string;
  gender: string | null;
  date_of_birth: string | null;
  dob_estimated: boolean;
  allergies: string | null;
  blood_group: string | null;
  phone: string;
}

export default async function WorkspacePage({
  params,
  searchParams,
}: {
  params: Promise<{ visitId: string }>;
  searchParams: Promise<{ busy?: string }>;
}) {
  await connection();
  const user = await requireStaff("records.view");
  const { visitId } = await params;
  const { busy } = await searchParams;

  const v = await one<VisitHeader>(
    pool(),
    `SELECT v.visit_id, v.status, v.token_number, v.reason, v.priority, v.doctor_id, d.full_name AS doctor_name,
            dep.name AS department, p.patient_id, p.full_name AS patient_name, p.uhid, p.gender, p.date_of_birth,
            p.dob_estimated, p.allergies, p.blood_group, p.phone
       FROM visits v
       JOIN patients p ON p.patient_id = v.patient_id
       JOIN doctors d ON d.doctor_id = v.doctor_id
       JOIN departments dep ON dep.department_id = v.department_id
      WHERE v.visit_id = $1`,
    [visitId],
  );
  if (!v) notFound();

  const isDoctor = user.role === "doctor";
  // A doctor opens only their own patients; a nurse may open anyone in the queue to record vitals.
  if (isDoctor && user.doctor_id !== v.doctor_id) redirect("/no-access");

  const canWrite = can(user.role, "consult.write") && user.doctor_id === v.doctor_id;
  const [vitals, consultation, history, body, medicines, imaging] = await Promise.all([
    visitVitals(pool(), visitId),
    getConsultationForVisit(pool(), visitId),
    patientHistory(pool(), v.patient_id, { excludeVisitId: visitId, limit: 5 }),
    latestBody(pool(), v.patient_id),
    many<{ name: string; generic_name: string; unit: string }>(pool(), `SELECT name, generic_name, unit FROM medicines WHERE active ORDER BY name`),
    can(user.role, "imaging.view") ? ordersForVisit(pool(), visitId) : Promise.resolve([]),
  ]);
  const canOrder = can(user.role, "imaging.order") && user.doctor_id === v.doctor_id && v.status !== "cancelled";

  const latest = vitals[0];
  const weight = latest?.weight_kg ?? body.weight_kg;
  const height = latest?.height_cm ?? body.height_cm;
  const finished = v.status === "completed";
  const editable = canWrite && v.status === "in_consultation";
  const canRecordVitals = can(user.role, "vitals.record") && (v.status === "waiting" || v.status === "in_consultation");

  return (
    <>
      <PageHeader
        title={v.patient_name}
        description={`Token ${v.token_number} · ${v.doctor_name} · ${v.department}`}
        actions={
          <Link href="/consult" className="text-sm text-muted hover:text-text">
            Back to queue
          </Link>
        }
      />
      {busy && (
        <p role="status" className="mb-4 rounded-lg bg-warn-soft px-4 py-2 text-sm text-warn">
          You still have a patient with you. Finish this consultation before calling the next.
        </p>
      )}

      {/* Patient banner: what must never be missed sits at the top. */}
      <div className="mb-6 rounded-xl border border-border bg-surface p-4">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
          <span>
            <span className="text-muted">UHID</span> <span className="num font-medium">{v.uhid}</span>
          </span>
          <span>
            <span className="text-muted">Age</span> <span className="font-medium">{formatAge(v.date_of_birth, v.dob_estimated)}</span>
          </span>
          {v.gender && <span className="capitalize">{v.gender}</span>}
          {v.blood_group && <Badge tone="info">{v.blood_group}</Badge>}
          {v.priority === "urgent" && <Badge tone="danger">Urgent</Badge>}
          <Link href={`/patients/${v.patient_id}`} className="text-primary underline">
            Full record
          </Link>
        </div>
        {v.reason && <p className="mt-2 text-sm text-muted">Reason for visit: {v.reason}</p>}
        <p className={`mt-2 rounded-lg px-3 py-2 text-sm ${v.allergies ? "bg-danger-soft text-danger" : "bg-surface-2 text-muted"}`}>
          {v.allergies ? `Allergy: ${v.allergies}` : "No allergies recorded."}
        </p>
      </div>

      <div className="grid gap-6 xl:grid-cols-3">
        <div className="space-y-6 xl:col-span-2">
          {canRecordVitals && (
            <Card title="Record vitals">
              <div className="p-4">
                <VitalsForm visitId={visitId} />
              </div>
            </Card>
          )}

          {(canOrder || imaging.length > 0) && (
            <Card title="Imaging">
              <div className="space-y-4 p-4">
                <OrdersList visitId={visitId} orders={imaging} canCancel={canOrder} />
                {canOrder && <OrderForm visitId={visitId} studies={STUDY_CATALOGUE} />}
              </div>
            </Card>
          )}

          {consultation && (finished || !canWrite) ? (
            <Record consultation={consultation} />
          ) : editable ? (
            <ConsultForm
              visitId={visitId}
              allergies={v.allergies}
              medicines={medicines}
              initial={
                consultation
                  ? {
                      chief_complaint: consultation.chief_complaint ?? "",
                      history: consultation.history ?? "",
                      examination: consultation.examination ?? "",
                      diagnosis: consultation.diagnosis ?? "",
                      advice: consultation.advice ?? "",
                      follow_up_date: consultation.follow_up_date ?? "",
                      allergy_override_reason: consultation.allergy_override_reason ?? "",
                      items: consultation.items.map((i) => ({
                        medicine_name: i.medicine_name,
                        dose_units: String(i.dose_units),
                        frequency: i.frequency,
                        duration_days: String(i.duration_days),
                        timing: i.timing,
                        quantity: i.frequency === "SOS" ? String(i.quantity) : "",
                        instructions: i.instructions ?? "",
                      })),
                    }
                  : undefined
              }
            />
          ) : (
            <Card>
              <Empty>
                {v.status === "waiting"
                  ? canWrite
                    ? "Call this patient in from your queue to start the consultation."
                    : "This patient is waiting to be seen."
                  : "There is no consultation record for this visit."}
              </Empty>
            </Card>
          )}

          {finished && consultation && canWrite && (
            <Card title="Add a note to this record">
              <div className="p-4">
                <AddendumForm visitId={visitId} consultationId={consultation.consultation_id} />
              </div>
            </Card>
          )}
        </div>

        <div className="space-y-6">
          <Card title="Vitals">
            {vitals.length === 0 ? (
              <Empty>None recorded for this visit.</Empty>
            ) : (
              <div className="space-y-3 p-4 text-sm">
                <dl className="grid grid-cols-2 gap-x-4 gap-y-2">
                  {latest!.bp_systolic !== null && <Reading label="Blood pressure" value={`${latest!.bp_systolic}/${latest!.bp_diastolic} mmHg`} />}
                  {latest!.pulse !== null && <Reading label="Pulse" value={`${latest!.pulse} /min`} />}
                  {latest!.temperature_c !== null && <Reading label="Temperature" value={`${latest!.temperature_c} °C`} />}
                  {latest!.spo2 !== null && <Reading label="SpO₂" value={`${latest!.spo2} %`} />}
                  {latest!.resp_rate !== null && <Reading label="Resp. rate" value={`${latest!.resp_rate} /min`} />}
                  {weight !== null && <Reading label="Weight" value={`${weight} kg`} />}
                  {height !== null && <Reading label="Height" value={`${height} cm`} />}
                  {bmi(weight, height) !== null && <Reading label="BMI" value={String(bmi(weight, height))} />}
                </dl>
                <p className="text-xs text-muted">
                  {formatDateTime(latest!.recorded_at)} · {latest!.recorded_by_name}
                  {vitals.length > 1 && ` · ${vitals.length} readings today`}
                </p>
              </div>
            )}
          </Card>

          <Card title="Previous visits">
            {history.length === 0 ? (
              <Empty>No earlier consultations on record.</Empty>
            ) : (
              <ul className="divide-y divide-border">
                {history.map((h) => (
                  <li key={h.consultation_id} className="space-y-1 px-4 py-3 text-sm">
                    <div className="flex justify-between gap-2">
                      <span className="font-medium">{h.diagnosis}</span>
                      <span className="num shrink-0 text-xs text-muted">{formatDateOnly(h.visit_date).split(", ").slice(1).join(", ")}</span>
                    </div>
                    <div className="text-xs text-muted">{h.doctor_name}</div>
                    {h.items.length > 0 && (
                      <ul className="list-inside list-disc text-xs text-muted">
                        {h.items.map((i) => (
                          <li key={i.item_id}>{describeItem({ ...i, unit: i.unit ?? undefined })}</li>
                        ))}
                      </ul>
                    )}
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

function Reading({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="num font-medium">{value}</dd>
    </div>
  );
}

/** A finished consultation, read-only, with any later notes under it. */
function Record({ consultation }: { consultation: NonNullable<Awaited<ReturnType<typeof getConsultationForVisit>>> }) {
  const sections: [string, string | null][] = [
    ["Reason for visit", consultation.chief_complaint],
    ["History", consultation.history],
    ["Examination", consultation.examination],
    ["Diagnosis", consultation.diagnosis],
    ["Advice", consultation.advice],
  ];
  return (
    <Card
      title="Consultation record"
      action={<Badge tone={consultation.status === "final" ? "ok" : "warn"}>{consultation.status === "final" ? "Finished" : "Draft"}</Badge>}
    >
      <div className="space-y-4 p-4 text-sm">
        {sections
          .filter(([, text]) => text)
          .map(([label, text]) => (
            <div key={label}>
              <div className="text-xs font-medium tracking-wide text-muted uppercase">{label}</div>
              <p className="mt-0.5 whitespace-pre-wrap">{text}</p>
            </div>
          ))}
        {consultation.items.length > 0 && (
          <div>
            <div className="text-xs font-medium tracking-wide text-muted uppercase">Prescription</div>
            <ol className="mt-1 list-inside list-decimal space-y-1">
              {consultation.items.map((i) => (
                <li key={i.item_id}>
                  {describeItem({ ...i, unit: i.unit ?? undefined })}
                  {i.instructions && <span className="text-muted"> — {i.instructions}</span>}
                </li>
              ))}
            </ol>
            {consultation.allergy_override_reason && (
              <p className="mt-2 rounded-lg bg-warn-soft px-3 py-2 text-xs text-warn">
                Allergy reviewed by the doctor: {consultation.allergy_override_reason}
              </p>
            )}
          </div>
        )}
        {consultation.follow_up_date && (
          <p>
            <span className="text-muted">Follow-up:</span> {formatDateOnly(consultation.follow_up_date)}
          </p>
        )}
        {consultation.addenda.length > 0 && (
          <div className="border-t border-border pt-3">
            <div className="text-xs font-medium tracking-wide text-muted uppercase">Later notes</div>
            <ul className="mt-1 space-y-2">
              {consultation.addenda.map((a, i) => (
                <li key={i}>
                  <p className="whitespace-pre-wrap">{a.note}</p>
                  <p className="text-xs text-muted">
                    {a.author} · {formatDateTime(a.created_at)}
                  </p>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Card>
  );
}
