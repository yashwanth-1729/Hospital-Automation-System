import { connection } from "next/server";
import { AutoRefresh } from "@/components/client";
import { Badge, Card, Empty, PageHeader, Stat } from "@/components/ui";
import { formatDateTime } from "@/lib/time";
import { getFeedbackStats, listFeedback } from "@/server/queries";

export const metadata = { title: "Feedback" };

function Stars({ rating }: { rating: number }) {
  return (
    <span aria-label={`${rating} out of 5`} className={rating >= 4 ? "text-ok" : rating <= 2 ? "text-danger" : "text-warn"}>
      {"★".repeat(rating)}
      <span className="text-muted">{"☆".repeat(5 - rating)}</span>
    </span>
  );
}

export default async function FeedbackPage() {
  await connection();
  const [items, stats] = await Promise.all([listFeedback(), getFeedbackStats()]);
  const responseRate = stats.requests_sent ? Math.round((stats.responses / stats.requests_sent) * 100) : null;

  return (
    <>
      <AutoRefresh seconds={8} />
      <PageHeader
        title="Patient feedback"
        description="Collected after discharge. Anything at 3 stars or below opens a service-recovery task immediately."
      />

      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Average rating" value={stats.average_rating === null ? "—" : `${stats.average_rating}/5`} tone="primary" />
        <Stat label="Responses" value={stats.responses} hint={responseRate === null ? "no requests yet" : `${responseRate}% of ${stats.requests_sent} requests`} />
        <Stat label="Happy (4-5)" value={stats.promoters} tone="ok" />
        <Stat
          label="Service recovery"
          value={stats.service_recovery_open}
          tone={stats.service_recovery_open ? "danger" : "neutral"}
          hint="open tasks"
          href="/follow-ups"
        />
      </div>

      <Card>
        {items.length === 0 ? (
          <Empty>No feedback yet. Record a discharge to send a feedback request.</Empty>
        ) : (
          <ul className="divide-y divide-border">
            {items.map((f) => (
              <li key={f.feedback_id} className="px-4 py-4">
                <div className="flex flex-wrap items-center gap-3">
                  <Stars rating={f.rating} />
                  <span className="font-medium">{f.patient_name}</span>
                  {f.department && <Badge>{f.department}</Badge>}
                  {f.rating <= 3 && <Badge tone="danger">service recovery</Badge>}
                  <span className="num ml-auto text-xs text-muted">{formatDateTime(f.created_at)}</span>
                </div>
                {f.comment && <p className="mt-2 rounded-lg bg-surface-2 p-3 text-sm">{f.comment}</p>}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
