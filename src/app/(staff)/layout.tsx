import { connection } from "next/server";
import { NavLink } from "@/components/client";
import { env } from "@/lib/env";
import { can, ROLE_LABEL, type Capability } from "@/lib/rbac";
import { requireStaff } from "@/server/auth/guard";
import { getDashboardStats, getSystemHealth } from "@/server/queries";
import { logoutAction } from "./account/actions";

/** One entry per page in the sidebar. A person sees an entry only if their role grants its capability. */
const NAV: { href: string; label: string; capability: Capability; badge?: "exceptions" }[] = [
  { href: "/", label: "Dashboard", capability: "dashboard.view" },
  { href: "/reception", label: "Reception", capability: "queue.view" },
  { href: "/consult", label: "Consultation", capability: "records.view" },
  { href: "/pharmacy", label: "Pharmacy", capability: "pharmacy.dispense" },
  { href: "/billing", label: "Billing", capability: "billing.view" },
  { href: "/leads", label: "Leads", capability: "leads.manage" },
  { href: "/appointments", label: "Appointments", capability: "appointments.view" },
  { href: "/discharges", label: "Discharges", capability: "discharges.manage" },
  { href: "/follow-ups", label: "Follow-ups", capability: "followups.manage" },
  { href: "/feedback", label: "Feedback", capability: "feedback.view" },
  { href: "/reports", label: "Reports", capability: "reports.view" },
  { href: "/audits", label: "Audits", capability: "audits.manage" },
  { href: "/exceptions", label: "Exceptions", capability: "exceptions.manage", badge: "exceptions" },
  { href: "/phone", label: "Demo phone", capability: "demo.phone" },
  { href: "/admin/users", label: "Staff accounts", capability: "users.manage" },
];

export default async function StaffLayout({ children }: { children: React.ReactNode }) {
  await connection();
  const user = await requireStaff(undefined, { allowPasswordChange: true });
  const [health, stats] = await Promise.all([getSystemHealth(), getDashboardStats().catch(() => null)]);
  const e = env();
  const nav = user.must_change_password ? [] : NAV.filter((item) => can(user.role, item.capability));

  return (
    <div className="flex min-h-screen flex-col md:flex-row">
      <aside className="border-b border-border bg-surface md:sticky md:top-0 md:flex md:h-screen md:w-60 md:shrink-0 md:flex-col md:border-r md:border-b-0">
        <div className="flex items-center gap-2 px-4 py-4">
          <div className="grid h-8 w-8 place-items-center rounded-lg bg-primary text-sm font-bold text-white">N</div>
          <div>
            <div className="text-sm font-semibold leading-tight">NIT Care Ops</div>
            <div className="text-xs text-muted leading-tight">{e.HOSPITAL_NAME}</div>
          </div>
        </div>
        <nav className="flex gap-1 overflow-x-auto px-2 pb-3 md:flex-1 md:flex-col md:overflow-y-auto">
          {nav.map((item) => (
            <NavLink key={item.href} href={item.href} badge={item.badge === "exceptions" ? stats?.exceptions_high : undefined}>
              {item.label}
            </NavLink>
          ))}
          {can(user.role, "leads.manage") && (
            <a href="/enquiry" target="_blank" className="rounded-lg px-3 py-2 text-sm whitespace-nowrap text-muted hover:bg-surface-2 hover:text-text">
              Patient form ↗
            </a>
          )}
        </nav>
        <div className="space-y-3 border-t border-border px-4 py-4 text-xs text-muted">
          <div className="hidden space-y-1.5 md:block">
            <StatusDot ok={health.database} label="Database" />
            <StatusDot ok={health.worker_online} label={health.worker_online ? "Worker online" : "Worker offline"} />
            <div>AI: {e.AI_PROVIDER === "rules" ? "rules engine" : e.AI_MODEL}</div>
            <div>Messaging: {e.MESSAGING_PROVIDER === "mock" ? "demo phone" : "WhatsApp Cloud"}</div>
          </div>
          <div className="flex items-center justify-between gap-2">
            <a href="/account" className="min-w-0 hover:text-text">
              <div className="truncate text-sm font-medium text-text">{user.full_name}</div>
              <div>{ROLE_LABEL[user.role]}</div>
            </a>
            <form action={logoutAction}>
              <button className="rounded-lg border border-border px-2 py-1 hover:border-primary hover:text-primary">Sign out</button>
            </form>
          </div>
        </div>
      </aside>
      <main className="min-w-0 flex-1 px-4 py-6 md:px-8">
        {!health.worker_online && health.database && can(user.role, "exceptions.manage") && (
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
