import Link from "next/link";
import { connection } from "next/server";
import { AutoRefresh } from "@/components/client";
import { Badge, Card, Empty, PageHeader, Stat } from "@/components/ui";
import { formatDateTime, formatSlot } from "@/lib/time";
import { getNoShowStats, listFollowUps } from "@/server/queries";
import { closeFollowUpAction } from "./actions";

export const metadata = { title: "Follow-ups" };

export default async function FollowUpsPage({ searchParams }: { searchParams: Promise<{ view?: string }> }) {
  await connection();
  const view = (await searchParams).view === "closed" ? "closed" : "open";
  const [items, stats] = await Promise.all([listFollowUps(view), getNoShowStats()]);
  const now = Date.now();

  return (
    <>
      <AutoRefresh seconds={8} />
      <PageHeader
        title="Follow-ups"
        description="Patients the automation is chasing after a missed appointment, and the ones reception needs to call."
        actions={
          <div className="flex gap-2 text-sm">
            <Link href="/follow-ups" className={view === "open" ? "font-medium text-primary" : "text-muted"}>Open</Link>
            <span className="text-border">|</span>
            <Link href="/follow-ups?view=closed" className={view === "closed" ? "font-medium text-primary" : "text-muted"}>Closed</Link>
          </div>
        }
      />

      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="No-shows (7 days)" value={stats.no_shows_7d} tone={stats.no_shows_7d ? "warn" : "neutral"} />
        <Stat label="Recovered" value={stats.recovered_7d} tone="ok" hint="patient rebooked after a miss" />
        <Stat label="Being chased" value={stats.recovery_open} hint="automated follow-up in progress" />
        <Stat label="No-show rate" value={stats.no_show_rate_7d === null ? "—" : `${stats.no_show_rate_7d}%`} hint="of visits with attendance recorded" />
      </div>

      <Card>
        {items.length === 0 ? (
          <Empty>{view === "open" ? "No open follow-ups." : "Nothing closed yet."}</Empty>
        ) : (
          <ul className="divide-y divide-border">
            {items.map((f) => {
              const due = view === "open" && f.next_action_at && new Date(f.next_action_at).getTime() < now;
              return (
                <li key={f.followup_id} className="grid gap-3 px-4 py-4 md:grid-cols-[1fr_auto]">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{f.patient_name}</span>
                      <span className="num text-xs text-muted">{f.phone}</span>
                      <Badge tone="info">{f.category.replaceAll("_", " ")}</Badge>
                      <Badge>attempt {f.attempt_count}</Badge>
                      {due && <Badge tone="warn">due now</Badge>}
                      {view === "closed" && <Badge tone={f.status === "done" ? "ok" : "neutral"}>{f.status}</Badge>}
                    </div>
                    {f.missed_slot && <p className="mt-1 text-sm">Missed {formatSlot(f.missed_slot)}</p>}
                    {f.notes && <p className="mt-1 text-sm text-muted">{f.notes.trim()}</p>}
                    <div className="mt-1 text-xs text-muted">
                      opened {formatDateTime(f.created_at)}
                      {view === "open" && f.next_action_at && <> · next action {formatDateTime(f.next_action_at)}</>}
                      {f.lead_id && (
                        <>
                          {" · "}
                          <Link href={`/leads/${f.lead_id}`} className="text-primary">open lead</Link>
                        </>
                      )}
                    </div>
                  </div>
                  {view === "open" && (
                    <form action={closeFollowUpAction} className="flex items-start gap-2">
                      <input type="hidden" name="followup_id" value={f.followup_id} />
                      <input name="note" placeholder="Outcome of the call" aria-label="Outcome" className="w-44 rounded-lg border border-border bg-surface px-3 py-1.5 text-sm" />
                      <button name="outcome" value="done" className="rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-white hover:opacity-90">
                        Rebooked
                      </button>
                      <button name="outcome" value="cancelled" className="rounded-lg border border-border px-3 py-1.5 text-sm text-muted hover:text-text">
                        Close
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
