import { connection } from "next/server";
import { AutoRefresh } from "@/components/client";
import { Badge, Card, Empty, PageHeader, Td, Th } from "@/components/ui";
import { maskPhone } from "@/lib/phone";
import { formatDateOnly, formatDateTime } from "@/lib/time";
import { listDepartments, listDischarges } from "@/server/queries";
import { DischargeForm } from "./form";

export const metadata = { title: "Discharges" };

const STATUS_TONE = { scheduled: "ok", needs_review: "warn", new: "info", closed: "neutral" } as const;

export default async function DischargesPage() {
  await connection();
  const [discharges, departments] = await Promise.all([listDischarges(), listDepartments()]);

  return (
    <>
      <AutoRefresh seconds={8} />
      <PageHeader
        title="Discharges"
        description="Post-discharge coordination: the approved follow-up is relayed to the patient, reminded the day before, and feedback is requested afterwards."
      />

      <Card title="Record a discharge" className="mb-6">
        <DischargeForm departments={departments} />
      </Card>

      <Card title="Recent discharges">
        {discharges.length === 0 ? (
          <Empty>No discharges recorded yet. Use the form above, or send one to /api/webhooks/discharge from the HMS.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="border-b border-border">
                <tr>
                  <Th>Patient</Th>
                  <Th>Discharged</Th>
                  <Th>Approved follow-up</Th>
                  <Th>Status</Th>
                  <Th>Feedback</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {discharges.map((d) => (
                  <tr key={d.discharge_id} className="hover:bg-surface-2">
                    <Td>
                      <span className="font-medium">{d.patient_name}</span>
                      <div className="num text-xs text-muted">{maskPhone(d.phone)}</div>
                      <div className="text-xs text-muted">{d.department ?? "—"}{d.encounter_id ? ` · ${d.encounter_id}` : ""}</div>
                    </Td>
                    <Td className="num whitespace-nowrap">{formatDateTime(d.discharged_at)}</Td>
                    <Td>
                      {d.approved_followup_date ? (
                        <>
                          {formatDateOnly(d.approved_followup_date)}
                          {d.approved_followup_window && <span className="text-muted"> · {d.approved_followup_window}</span>}
                          <div className="text-xs text-muted">approved by {d.approved_by}</div>
                        </>
                      ) : (
                        <span className="text-warn">awaiting clinician</span>
                      )}
                    </Td>
                    <Td>
                      <Badge tone={STATUS_TONE[d.status as keyof typeof STATUS_TONE] ?? "neutral"}>{d.status.replace("_", " ")}</Badge>
                    </Td>
                    <Td>
                      {d.feedback_rating ? (
                        <Badge tone={d.feedback_rating >= 4 ? "ok" : d.feedback_rating <= 2 ? "danger" : "warn"}>{d.feedback_rating}/5</Badge>
                      ) : (
                        <span className="text-xs text-muted">awaiting</span>
                      )}
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
