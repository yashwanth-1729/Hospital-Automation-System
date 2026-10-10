import Link from "next/link";
import { connection } from "next/server";
import { AutoRefresh } from "@/components/client";
import { Badge, Card, Empty, PageHeader, Stat, Td, Th } from "@/components/ui";
import { formatAge } from "@/lib/age";
import { pool } from "@/lib/db";
import { maskPhone } from "@/lib/phone";
import { can } from "@/lib/rbac";
import { formatDateTime, formatSlot } from "@/lib/time";
import { requireStaff } from "@/server/auth/guard";
import { listActiveDoctors } from "@/server/clinic/directory";
import { searchPatients } from "@/server/clinic/patients";
import { listExpectedToday, listQueue, queueSummary, type QueueRow } from "@/server/clinic/visits";
import { cancelVisitAction, checkInAction, setPriorityAction } from "./actions";
import { ActionButton, StartVisitForm } from "./controls";

export const metadata = { title: "Reception" };

const STATUS_TONE = { waiting: "warn", in_consultation: "info", completed: "ok", cancelled: "neutral" } as const;
const STATUS_LABEL = { waiting: "Waiting", in_consultation: "With doctor", completed: "Seen", cancelled: "Left" } as const;

export default async function ReceptionPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; registered?: string; matched?: string }>;
}) {
  await connection();
  const user = await requireStaff("queue.view");
  const manage = can(user.role, "queue.manage");
  const { q = "", registered, matched } = await searchParams;

  const [queue, expected, summary, doctors, found] = await Promise.all([
    listQueue(pool()),
    listExpectedToday(pool()),
    queueSummary(pool()),
    manage ? listActiveDoctors(pool()) : Promise.resolve([]),
    manage || can(user.role, "patients.view") ? searchPatients(pool(), q, q ? 15 : 6) : Promise.resolve([]),
  ]);

  const byDoctor = new Map<string, { name: string; department: string; rows: QueueRow[] }>();
  for (const row of queue) {
    const group = byDoctor.get(row.doctor_id) ?? { name: row.doctor_name, department: row.department, rows: [] };
    group.rows.push(row);
    byDoctor.set(row.doctor_id, group);
  }
  const awaitingCheckIn = expected.filter((e) => !e.visit_id);

  return (
    <>
      <AutoRefresh seconds={8} />
      <PageHeader
        title="Reception"
        description="Today's queue, expected appointments and patient lookup."
        actions={
          can(user.role, "patients.register") && (
            <Link href="/reception/register" className="rounded-lg bg-primary px-3 py-2 text-sm font-medium text-white hover:opacity-90">
              Register patient
            </Link>
          )
        }
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Waiting" value={summary.waiting} tone={summary.waiting ? "warn" : "neutral"} hint={summary.longest_wait_minutes ? `longest ${summary.longest_wait_minutes} min` : "nobody waiting"} />
        <Stat label="With a doctor" value={summary.in_consultation} tone="info" />
        <Stat label="Seen today" value={summary.completed} tone="ok" />
        <Stat label="Expected" value={awaitingCheckIn.length} hint="booked, not yet arrived" />
      </div>

      {(registered || matched) && found[0] && (
        <p role="status" className="mt-4 rounded-lg bg-ok-soft px-4 py-2 text-sm text-ok">
          {registered ? "Registered" : "Already on file"}: {found[0].full_name} ({found[0].uhid}).{" "}
          {queue.some((r) => r.patient_id === found[0]!.patient_id && r.status === "waiting")
            ? "They are in the queue."
            : "Issue a token below if they are here to be seen."}
        </p>
      )}

      <div className="mt-6 grid gap-6 xl:grid-cols-5">
        <div className="space-y-6 xl:col-span-3">
          {byDoctor.size === 0 ? (
            <Card title="Queue">
              <Empty>Nobody has checked in yet today.</Empty>
            </Card>
          ) : (
            [...byDoctor.entries()].map(([doctorId, group]) => (
              <Card key={doctorId} title={`${group.name} · ${group.department}`}>
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead className="border-b border-border">
                      <tr>
                        <Th>Token</Th>
                        <Th>Patient</Th>
                        <Th>Status</Th>
                        <Th>Waited</Th>
                        {manage && <Th></Th>}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {group.rows.map((r) => (
                        <tr key={r.visit_id} className={r.status === "completed" || r.status === "cancelled" ? "opacity-60" : "hover:bg-surface-2"}>
                          <Td className="num text-lg font-semibold">
                            {r.token_number}
                            {r.priority === "urgent" && <div><Badge tone="danger">Urgent</Badge></div>}
                          </Td>
                          <Td>
                            <Link href={`/patients/${r.patient_id}`} className="font-medium hover:text-primary">{r.patient_name}</Link>
                            <div className="text-xs text-muted">
                              {r.uhid} · {formatAge(r.date_of_birth, r.dob_estimated)}
                              {r.gender ? ` · ${r.gender}` : ""}
                            </div>
                            {r.reason && <div className="text-xs text-muted">{r.reason}</div>}
                            {r.allergies && <div className="mt-0.5 text-xs text-danger">Allergy: {r.allergies}</div>}
                          </Td>
                          <Td><Badge tone={STATUS_TONE[r.status]}>{STATUS_LABEL[r.status]}</Badge></Td>
                          <Td className="num text-sm">{r.status === "waiting" ? `${r.wait_minutes} min` : r.status === "in_consultation" ? `${r.wait_minutes} min` : "—"}</Td>
                          {manage && (
                            <Td>
                              {r.status === "waiting" && (
                                <div className="flex flex-wrap gap-1.5">
                                  <ActionButton
                                    action={setPriorityAction}
                                    fields={{ visit_id: r.visit_id, priority: r.priority === "urgent" ? "normal" : "urgent" }}
                                    label={r.priority === "urgent" ? "Not urgent" : "Urgent"}
                                  />
                                  <ActionButton action={cancelVisitAction} fields={{ visit_id: r.visit_id, reason: "Left before consultation" }} label="Remove" tone="danger" />
                                </div>
                              )}
                            </Td>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>
            ))
          )}
        </div>

        <div className="space-y-6 xl:col-span-2">
          <Card title={`Expected today (${expected.length})`}>
            {expected.length === 0 ? (
              <Empty>No booked appointments today.</Empty>
            ) : (
              <ul className="divide-y divide-border">
                {expected.map((e) => (
                  <li key={e.appointment_id} className="flex items-start justify-between gap-3 px-4 py-3">
                    <div className="min-w-0">
                      <div className="text-sm font-medium">{e.patient_name}</div>
                      <div className="text-xs text-muted">
                        {formatSlot(e.slot_start).split(", ").slice(-1)[0]} · {e.doctor_name}
                      </div>
                    </div>
                    {e.visit_id ? (
                      <Badge tone={e.visit_status ? STATUS_TONE[e.visit_status] : "neutral"}>
                        Token {e.token_number}
                      </Badge>
                    ) : (
                      manage && <ActionButton action={checkInAction} fields={{ appointment_id: e.appointment_id }} label="Check in" tone="primary" />
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card title="Find a patient">
            <form className="border-b border-border p-4" action="/reception" method="get">
              <input
                name="q"
                defaultValue={q}
                placeholder="Name, UHID or mobile number"
                aria-label="Search patients"
                className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-primary"
              />
            </form>
            {found.length === 0 ? (
              <Empty>
                {q ? "No patient matches that." : "No patients yet."}{" "}
                {can(user.role, "patients.register") && (
                  <Link href="/reception/register" className="text-primary underline">Register one</Link>
                )}
              </Empty>
            ) : (
              <ul className="divide-y divide-border">
                {found.map((p) => (
                  <li key={p.patient_id} className="space-y-2 px-4 py-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <Link href={`/patients/${p.patient_id}`} className="text-sm font-medium hover:text-primary">{p.full_name}</Link>
                        <div className="text-xs text-muted">
                          {p.uhid} · {formatAge(p.date_of_birth, p.dob_estimated)}
                          {p.gender ? ` · ${p.gender}` : ""} · <span className="num">{maskPhone(p.phone)}</span>
                        </div>
                        {p.last_visit_date && <div className="text-xs text-muted">Last visit {formatDateTime(new Date(`${p.last_visit_date}T12:00:00+05:30`)).split(",")[0]}</div>}
                      </div>
                    </div>
                    {p.allergies && <div className="text-xs text-danger">Allergy: {p.allergies}</div>}
                    {manage && <StartVisitForm patientId={p.patient_id} doctors={doctors} />}
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
