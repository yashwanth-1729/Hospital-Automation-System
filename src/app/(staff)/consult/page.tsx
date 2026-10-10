import Link from "next/link";
import { connection } from "next/server";
import { AutoRefresh } from "@/components/client";
import { Badge, Card, Empty, PageHeader, Stat } from "@/components/ui";
import { formatAge } from "@/lib/age";
import { many, pool } from "@/lib/db";
import { can } from "@/lib/rbac";
import { requireStaff } from "@/server/auth/guard";
import { listQueue } from "@/server/clinic/visits";
import { callInAction } from "./actions";

export const metadata = { title: "Consultation" };

export default async function ConsultPage({ searchParams }: { searchParams: Promise<{ done?: string }> }) {
  await connection();
  const user = await requireStaff("records.view");
  const { done } = await searchParams;
  const isDoctor = can(user.role, "consult.write") && !!user.doctor_id;

  const queue = await listQueue(pool(), { doctorId: isDoctor ? user.doctor_id! : undefined });
  // Which waiting patients already have vitals, so the doctor knows who is ready to be seen.
  const withVitals = new Set(
    (
      await many<{ visit_id: string }>(
        pool(),
        `SELECT DISTINCT visit_id FROM vitals WHERE visit_id = ANY($1::text[])`,
        [queue.map((q) => q.visit_id)],
      )
    ).map((r) => r.visit_id),
  );

  const current = queue.filter((q) => q.status === "in_consultation");
  const waiting = queue.filter((q) => q.status === "waiting");
  const seen = queue.filter((q) => q.status === "completed");

  return (
    <>
      <AutoRefresh seconds={8} />
      <PageHeader
        title={isDoctor ? "My patients" : "Consultation queue"}
        description={isDoctor ? "Today's queue, in the order you will see them. Urgent patients are first." : "Everyone waiting or with a doctor. Open a patient to record vitals."}
      />
      {done && (
        <p role="status" className="mb-4 rounded-lg bg-ok-soft px-4 py-2 text-sm text-ok">
          Consultation finished. The prescription is with the pharmacy and the patient has been notified.
        </p>
      )}

      <div className="grid grid-cols-3 gap-3">
        <Stat label="Waiting" value={waiting.length} tone={waiting.length ? "warn" : "neutral"} />
        <Stat label="With a doctor" value={current.length} tone="info" />
        <Stat label="Seen today" value={seen.length} tone="ok" />
      </div>

      {current.length > 0 && (
        <Card title="With a doctor now" className="mt-6">
          <ul className="divide-y divide-border">
            {current.map((r) => (
              <li key={r.visit_id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                <div>
                  <div className="font-medium">
                    Token {r.token_number} · {r.patient_name}
                  </div>
                  <div className="text-xs text-muted">
                    {r.uhid} · {formatAge(r.date_of_birth, r.dob_estimated)} · {r.doctor_name}
                  </div>
                </div>
                <Link href={`/consult/${r.visit_id}`} className="rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-white hover:opacity-90">
                  {isDoctor ? "Continue" : "Open"}
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card title={`Waiting (${waiting.length})`} className="mt-6">
        {waiting.length === 0 ? (
          <Empty>Nobody is waiting.</Empty>
        ) : (
          <ul className="divide-y divide-border">
            {waiting.map((r, i) => (
              <li key={r.visit_id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                <div className="flex items-start gap-4">
                  <div className="num grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-surface-2 text-lg font-semibold">{r.token_number}</div>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2 font-medium">
                      {r.patient_name}
                      {r.priority === "urgent" && <Badge tone="danger">Urgent</Badge>}
                      {i === 0 && isDoctor && current.length === 0 && <Badge tone="primary">Next</Badge>}
                    </div>
                    <div className="text-xs text-muted">
                      {r.uhid} · {formatAge(r.date_of_birth, r.dob_estimated)}
                      {r.gender ? ` · ${r.gender}` : ""} · waiting {r.wait_minutes} min
                      {!isDoctor && ` · ${r.doctor_name}`}
                    </div>
                    {r.reason && <div className="text-xs text-muted">{r.reason}</div>}
                    {r.allergies && <div className="text-xs text-danger">Allergy: {r.allergies}</div>}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {withVitals.has(r.visit_id) ? <Badge tone="ok">Vitals taken</Badge> : <Badge>No vitals</Badge>}
                  {isDoctor ? (
                    <form action={callInAction}>
                      <input type="hidden" name="visit_id" value={r.visit_id} />
                      <button className="rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-white hover:opacity-90">Call in</button>
                    </form>
                  ) : (
                    <Link href={`/consult/${r.visit_id}`} className="rounded-lg border border-border px-3 py-1.5 text-sm hover:border-primary hover:text-primary">
                      Record vitals
                    </Link>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
