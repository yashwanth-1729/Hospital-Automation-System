import Link from "next/link";
import { connection } from "next/server";
import { AutoRefresh } from "@/components/client";
import { Badge, Card, Empty, PageHeader, Td, Th } from "@/components/ui";
import { maskPhone } from "@/lib/phone";
import { formatDateTime, formatSlot } from "@/lib/time";
import { listAppointments } from "@/server/queries";
import { markAttendanceAction } from "./actions";

export const metadata = { title: "Appointments" };

export default async function AppointmentsPage() {
  await connection();
  const appts = await listAppointments();

  return (
    <>
      <AutoRefresh seconds={10} />
      <PageHeader title="Appointments" description="Booked by the automation. Reminders go out 24 hours and 3 hours before each visit; a missed visit starts the recovery workflow." />
      <Card>
        {appts.length === 0 ? (
          <Empty>No appointments booked yet.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="border-b border-border">
                <tr>
                  <Th>When</Th>
                  <Th>Patient</Th>
                  <Th>Doctor</Th>
                  <Th>Status</Th>
                  <Th>Attendance</Th>
                  <Th>Reminders</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {appts.map((a) => (
                  <tr key={a.appointment_id} className="hover:bg-surface-2">
                    <Td className="num whitespace-nowrap">{formatSlot(a.slot_start)}</Td>
                    <Td>
                      {a.lead_id ? (
                        <Link href={`/leads/${a.lead_id}`} className="font-medium hover:text-primary">{a.patient_name}</Link>
                      ) : (
                        a.patient_name
                      )}
                      <div className="num text-xs text-muted">{maskPhone(a.phone)}</div>
                    </Td>
                    <Td>
                      {a.doctor_name}
                      <div className="text-xs text-muted">{a.department}</div>
                    </Td>
                    <Td>
                      <Badge tone={a.status === "booked" ? "ok" : "neutral"}>{a.status}</Badge>{" "}
                      {a.attendance_status !== "pending" && (
                        <Badge tone={a.attendance_status === "no_show" ? "danger" : "ok"}>{a.attendance_status.replace("_", "-")}</Badge>
                      )}
                    </Td>
                    <Td>
                      {a.status === "booked" && (
                        <form action={markAttendanceAction} className="flex gap-1.5">
                          <input type="hidden" name="appointment_id" value={a.appointment_id} />
                          {a.attendance_status === "pending" ? (
                            <>
                              <button name="attendance" value="attended" className="rounded-lg border border-border px-2 py-1 text-xs hover:border-ok hover:text-ok">
                                Attended
                              </button>
                              <button name="attendance" value="no_show" className="rounded-lg border border-border px-2 py-1 text-xs hover:border-danger hover:text-danger">
                                No-show
                              </button>
                            </>
                          ) : (
                            <button name="attendance" value="pending" className="rounded-lg border border-border px-2 py-1 text-xs text-muted hover:text-text">
                              Undo
                            </button>
                          )}
                        </form>
                      )}
                    </Td>
                    <Td className="text-xs text-muted">
                      <div>24h: {a.reminder_24h_at ? formatDateTime(a.reminder_24h_at) : "pending"}</div>
                      <div>3h: {a.reminder_3h_at ? formatDateTime(a.reminder_3h_at) : "pending"}</div>
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
