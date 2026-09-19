import { connection } from "next/server";
import { NavLink } from "@/components/client";
import { env } from "@/lib/env";
import { getDashboardStats, getSystemHealth } from "@/server/queries";

export default async function StaffLayout({ children }: { children: React.ReactNode }) {
  await connection();
  const [health, stats] = await Promise.all([getSystemHealth(), getDashboardStats().catch(() => null)]);
  const e = env();

  return (
    <div className="flex min-h-screen flex-col md:flex-row">
      <aside className="border-b border-border bg-surface md:sticky md:top-0 md:h-screen md:w-60 md:shrink-0 md:border-r md:border-b-0">
        <div className="flex items-center gap-2 px-4 py-4">
          <div className="grid h-8 w-8 place-items-center rounded-lg bg-primary text-sm font-bold text-white">N</div>
          <div>
            <div className="text-sm font-semibold leading-tight">NIT Care Ops</div>
            <div className="text-xs text-muted leading-tight">{e.HOSPITAL_NAME}</div>
          </div>
        </div>
        <nav className="flex gap-1 overflow-x-auto px-2 pb-3 md:flex-col md:overflow-visible">
          <NavLink href="/">Dashboard</NavLink>
          <NavLink href="/leads">Leads</NavLink>
          <NavLink href="/appointments">Appointments</NavLink>
          <NavLink href="/follow-ups">Follow-ups</NavLink>
          <NavLink href="/exceptions" badge={stats?.exceptions_high}>Exceptions</NavLink>
          <NavLink href="/phone">Demo phone</NavLink>
          <a href="/enquiry" target="_blank" className="rounded-lg px-3 py-2 text-sm whitespace-nowrap text-muted hover:bg-surface-2 hover:text-text">
            Patient form ↗
          </a>
        </nav>
        <div className="hidden space-y-1.5 border-t border-border px-4 py-4 text-xs text-muted md:absolute md:bottom-0 md:block md:w-60">
          <StatusDot ok={health.database} label="Database" />
          <StatusDot ok={health.worker_online} label={health.worker_online ? "Worker online" : "Worker offline"} />
          <div>AI: {e.AI_PROVIDER === "rules" ? "rules engine" : e.AI_MODEL}</div>
          <div>Messaging: {e.MESSAGING_PROVIDER === "mock" ? "demo phone" : "WhatsApp Cloud"}</div>
        </div>
      </aside>
      <main className="min-w-0 flex-1 px-4 py-6 md:px-8">
        {!health.worker_online && health.database && (
          <div className="mb-4 rounded-lg border border-warn/30 bg-warn-soft px-4 py-2 text-sm text-warn">
            The background worker is not running, so new leads will wait in the queue. Start it with <code className="font-mono">npm run worker</code>.
          </div>
        )}
        {children}
      </main>
    </div>
  );
}

function StatusDot({ ok, label }: { ok: boolean; label: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className={`h-2 w-2 rounded-full ${ok ? "bg-ok" : "bg-danger"}`} />
      {label}
    </div>
  );
}
