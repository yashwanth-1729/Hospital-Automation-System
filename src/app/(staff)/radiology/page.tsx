import Link from "next/link";
import { connection } from "next/server";
import { AutoRefresh } from "@/components/client";
import { Badge, Card, Empty, PageHeader, Stat } from "@/components/ui";
import { pool } from "@/lib/db";
import { formatDateTime } from "@/lib/time";
import { requireStaff } from "@/server/auth/guard";
import { MODALITIES, worklist, imagingCounts } from "@/server/radiology/imaging";

export const metadata = { title: "Radiology" };

export default async function RadiologyPage({ searchParams }: { searchParams: Promise<{ reported?: string }> }) {
  await connection();
  await requireStaff("imaging.view");
  const { reported: justReported } = await searchParams;
  const [{ open, reported }, counts] = await Promise.all([worklist(pool()), imagingCounts(pool())]);

  return (
    <>
      <AutoRefresh seconds={10} />
      <PageHeader title="Radiology" description="Studies ordered by doctors, urgent first. Open one to start it and write the report." />
      {justReported && (
        <p role="status" className="mb-4 rounded-lg bg-ok-soft px-4 py-2 text-sm text-ok">
          Report saved. The ordering doctor can read it on the patient's consultation screen.
        </p>
      )}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Waiting" value={counts.ordered} tone={counts.ordered ? "warn" : "neutral"} />
        <Stat label="In progress" value={counts.in_progress} tone="info" />
        <Stat label="Urgent open" value={counts.urgent_open} tone={counts.urgent_open ? "danger" : "neutral"} />
        <Stat label="Reported today" value={counts.reported_today} tone="ok" />
      </div>

      <Card title={`Worklist (${open.length})`} className="mt-6">
        {open.length === 0 ? (
          <Empty>No studies waiting. New orders from doctors appear here the moment they are made.</Empty>
        ) : (
          <ul className="divide-y divide-border">
            {open.map((o) => (
              <li key={o.order_id}>
                <Link href={`/radiology/${o.order_id}`} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 hover:bg-surface-2">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2 font-medium">
                      {o.study}
                      {o.priority === "urgent" && <Badge tone="danger">Urgent</Badge>}
                      {o.status === "in_progress" && <Badge tone="info">In progress</Badge>}
                    </div>
                    <div className="text-xs text-muted">
                      {o.patient_name} · {o.uhid} · {MODALITIES[o.modality]} · ordered by {o.doctor_name} · {formatDateTime(o.ordered_at)}
                    </div>
                    {o.indication && <div className="text-xs text-muted">Reason: {o.indication}</div>}
                    {o.allergies && <div className="text-xs text-danger">Allergy: {o.allergies}</div>}
                  </div>
                  <span className="text-sm text-primary">{o.status === "ordered" ? "Start" : "Continue"}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="Reported in the last two days" className="mt-6">
        {reported.length === 0 ? (
          <Empty>Nothing reported yet.</Empty>
        ) : (
          <ul className="divide-y divide-border">
            {reported.map((o) => (
              <li key={o.order_id} className="px-4 py-3 text-sm">
                <div className="flex flex-wrap justify-between gap-2">
                  <span className="font-medium">
                    {o.study} · {o.patient_name}
                  </span>
                  <span className="text-xs text-muted">{o.reported_at ? formatDateTime(o.reported_at) : ""}</span>
                </div>
                <div className="text-muted">{o.impression}</div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
