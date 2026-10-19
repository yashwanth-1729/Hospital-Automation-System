import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Badge, Card, PageHeader } from "@/components/ui";
import { pool } from "@/lib/db";
import { can } from "@/lib/rbac";
import { formatDateTime } from "@/lib/time";
import { requireStaff } from "@/server/auth/guard";
import { getOrder, MODALITIES } from "@/server/radiology/imaging";
import { startStudyAction } from "../actions";
import { ReportForm } from "./form";

export const metadata = { title: "Study" };

export default async function StudyPage({ params }: { params: Promise<{ orderId: string }> }) {
  await connection();
  const user = await requireStaff("imaging.view");
  const { orderId } = await params;
  const o = await getOrder(pool(), orderId);
  if (!o) notFound();
  const canReport = can(user.role, "imaging.report");

  return (
    <>
      <PageHeader
        title={o.study}
        description={`${o.patient_name} · ${o.uhid} · ${MODALITIES[o.modality]} · ordered by ${o.doctor_name}`}
        actions={
          <Link href="/radiology" className="text-sm text-muted hover:text-text">
            Back to the worklist
          </Link>
        }
      />
      <div className="mb-6 flex flex-wrap items-center gap-2 text-sm">
        <Badge tone={o.status === "reported" ? "ok" : o.status === "in_progress" ? "info" : o.status === "cancelled" ? "neutral" : "warn"}>
          {o.status === "in_progress" ? "In progress" : o.status === "ordered" ? "Waiting" : o.status === "reported" ? "Reported" : "Cancelled"}
        </Badge>
        {o.priority === "urgent" && <Badge tone="danger">Urgent</Badge>}
        <span className="text-muted">Ordered {formatDateTime(o.ordered_at)}</span>
      </div>
      {o.indication && <p className="mb-3 text-sm">Reason for the study: {o.indication}</p>}
      {o.allergies && <p className="mb-6 rounded-lg bg-danger-soft px-4 py-2 text-sm text-danger">Allergy: {o.allergies} (check before any contrast)</p>}

      {o.status === "reported" ? (
        <Card title="Report" action={<span className="text-xs text-muted">{o.reported_by_name} · {o.reported_at ? formatDateTime(o.reported_at) : ""}</span>}>
          <div className="space-y-4 p-4 text-sm">
            {o.findings && (
              <div>
                <div className="text-xs font-medium text-muted">Findings</div>
                <p className="mt-0.5 whitespace-pre-wrap">{o.findings}</p>
              </div>
            )}
            <div>
              <div className="text-xs font-medium text-muted">Impression</div>
              <p className="mt-0.5 font-medium whitespace-pre-wrap">{o.impression}</p>
            </div>
          </div>
        </Card>
      ) : o.status === "cancelled" ? (
        <Card>
          <div className="p-4 text-sm text-muted">This order was cancelled by the doctor.</div>
        </Card>
      ) : canReport ? (
        o.status === "ordered" ? (
          <Card title="Start this study">
            <form action={startStudyAction} className="p-4">
              <input type="hidden" name="order_id" value={o.order_id} />
              <button className="rounded-lg bg-primary px-5 py-2.5 text-sm font-semibold text-white hover:opacity-90">Start study</button>
              <p className="mt-2 text-xs text-muted">Starting tells the doctor that the patient is with radiology.</p>
            </form>
          </Card>
        ) : (
          <Card title="Write the report">
            <div className="p-4">
              <ReportForm orderId={o.order_id} />
            </div>
          </Card>
        )
      ) : (
        <Card>
          <div className="p-4 text-sm text-muted">Waiting for radiology.</div>
        </Card>
      )}
    </>
  );
}
