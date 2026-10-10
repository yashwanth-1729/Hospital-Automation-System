import Link from "next/link";
import { connection } from "next/server";
import { AutoRefresh } from "@/components/client";
import { Badge, Card, Empty, Mono, PageHeader, Severity } from "@/components/ui";
import { formatDateTime } from "@/lib/time";
import { listExceptions } from "@/server/queries";
import { resolveExceptionAction } from "./actions";
import { requireStaff } from "@/server/auth/guard";

export const metadata = { title: "Exceptions" };

export default async function ExceptionsPage({ searchParams }: { searchParams: Promise<{ view?: string }> }) {
  await connection();
  await requireStaff("exceptions.manage");
  const view = (await searchParams).view === "resolved" ? "resolved" : "open";
  const items = await listExceptions(view);
  const now = Date.now();

  return (
    <>
      <AutoRefresh seconds={5} />
      <PageHeader
        title="Exceptions"
        description="Everything the automation would not decide on its own. Nothing fails silently: it lands here with an owner and a due time."
        actions={
          <div className="flex gap-2 text-sm">
            <Link href="/exceptions" className={view === "open" ? "font-medium text-primary" : "text-muted"}>Open</Link>
            <span className="text-border">|</span>
            <Link href="/exceptions?view=resolved" className={view === "resolved" ? "font-medium text-primary" : "text-muted"}>Resolved</Link>
          </div>
        }
      />
      <Card>
        {items.length === 0 ? (
          <Empty>{view === "open" ? "The queue is clear." : "No resolved exceptions yet."}</Empty>
        ) : (
          <ul className="divide-y divide-border">
            {items.map((e) => {
              const overdue = view === "open" && e.due_at && new Date(e.due_at).getTime() < now;
              return (
                <li key={e.exception_id} className="grid gap-3 px-4 py-4 md:grid-cols-[1fr_auto]">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <Severity level={e.severity} />
                      <Mono>{e.error_type}</Mono>
                      {e.owner && <Badge>{e.owner.replace("_", " ")}</Badge>}
                      {overdue && <Badge tone="danger">overdue</Badge>}
                    </div>
                    <p className="mt-1.5 text-sm">{e.summary}</p>
                    <div className="mt-1 text-xs text-muted">
                      {e.workflow_name} · raised {formatDateTime(e.created_at)}
                      {view === "open" && e.due_at && <> · due {formatDateTime(e.due_at)}</>}
                      {e.lead_id && (
                        <>
                          {" · "}
                          <Link href={`/leads/${e.lead_id}`} className="text-primary">open lead</Link>
                        </>
                      )}
                    </div>
                    {e.resolution_note && <p className="mt-2 text-sm text-muted">Resolution: {e.resolution_note}</p>}
                  </div>
                  {view === "open" && (
                    <form action={resolveExceptionAction} className="flex items-start gap-2">
                      <input type="hidden" name="exception_id" value={e.exception_id} />
                      <input
                        name="note"
                        placeholder="What was done?"
                        aria-label="Resolution note"
                        className="w-48 rounded-lg border border-border bg-surface px-3 py-1.5 text-sm"
                      />
                      <button className="rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-white hover:opacity-90">
                        Resolve
                      </button>
                    </form>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </>
  );
}
