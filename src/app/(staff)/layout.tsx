import { connection } from "next/server";
import { NavLink } from "@/components/client";
import type { IconName } from "@/components/icons";
import { env } from "@/lib/env";
import { can, ROLE_LABEL, type Capability } from "@/lib/rbac";
import { requireStaff } from "@/server/auth/guard";
import { getDashboardStats, getSystemHealth } from "@/server/queries";
import { logoutAction } from "./account/actions";

interface Item {
  href: string;
  label: string;
  capability: Capability;
  icon: IconName;
  badge?: "exceptions";
}

/** Sidebar, grouped by the job a person is doing. A group appears only if something in it is allowed. */
const NAV: { heading?: string; items: Item[] }[] = [
  { items: [{ href: "/", label: "Dashboard", capability: "dashboard.view", icon: "home" }] },
  {
    heading: "Front desk",
    items: [
      { href: "/reception", label: "Reception", capability: "queue.view", icon: "desk" },
      { href: "/appointments", label: "Appointments", capability: "appointments.view", icon: "calendar" },
      { href: "/leads", label: "Enquiries", capability: "leads.manage", icon: "inbox" },
      { href: "/wards", label: "Wards", capability: "ipd.view", icon: "bed" },
    ],
  },
  {
    heading: "Care",
    items: [
      { href: "/consult", label: "Consultation", capability: "records.view", icon: "stethoscope" },
      { href: "/pharmacy", label: "Pharmacy", capability: "pharmacy.dispense", icon: "pill" },
      { href: "/billing", label: "Billing", capability: "billing.view", icon: "receipt" },
    ],
  },
  {
    heading: "After the visit",
    items: [
      { href: "/discharges", label: "Discharges", capability: "discharges.manage", icon: "discharge" },
      { href: "/follow-ups", label: "Follow-ups", capability: "followups.manage", icon: "bell" },
      { href: "/feedback", label: "Feedback", capability: "feedback.view", icon: "heart" },
      { href: "/exceptions", label: "Exceptions", capability: "exceptions.manage", icon: "alert", badge: "exceptions" },
    ],
  },
  {
    heading: "Insight",
    items: [
      { href: "/analytics", label: "Analytics", capability: "reports.view", icon: "chart" },
      { href: "/reports", label: "Reports", capability: "reports.view", icon: "document" },
      { href: "/audits", label: "Audits", capability: "audits.manage", icon: "document" },
    ],
  },
  {
    heading: "Admin",
    items: [
      { href: "/admin/users", label: "Staff accounts", capability: "users.manage", icon: "users" },
      { href: "/phone", label: "Demo phone", capability: "demo.phone", icon: "chat" },
    ],
  },
];

export default async function StaffLayout({ children }: { children: React.ReactNode }) {
  await connection();
  const user = await requireStaff(undefined, { allowPasswordChange: true });
  const [health, stats] = await Promise.all([getSystemHealth(), getDashboardStats().catch(() => null)]);
  const e = env();
  const groups = user.must_change_password
    ? []
    : NAV.map((g) => ({ ...g, items: g.items.filter((i) => can(user.role, i.capability)) })).filter((g) => g.items.length > 0);

  return (
    <div className="flex min-h-screen flex-col md:flex-row">
      <a
        href="#content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:rounded-lg focus:bg-primary focus:px-3 focus:py-2 focus:text-sm focus:text-white"
      >
        Skip to content
      </a>

      <aside className="border-b border-border/80 bg-surface/90 backdrop-blur md:sticky md:top-0 md:flex md:h-screen md:w-64 md:shrink-0 md:flex-col md:border-r md:border-b-0">
        <div className="flex items-center gap-3 px-5 pt-5 pb-4">
          <div className="grid h-9 w-9 place-items-center rounded-xl bg-primary text-white shadow-[var(--shadow-md)]">
            <svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" aria-hidden>
              <path d="M10 4v12M4 10h12" />
            </svg>
          </div>
          <div className="min-w-0">
            <div className="text-[15px] leading-tight font-semibold tracking-tight">NIT Care Ops</div>
            <div className="truncate text-xs leading-tight text-muted">{e.HOSPITAL_NAME}</div>
          </div>
        </div>

        <nav aria-label="Main" className="flex gap-1 overflow-x-auto px-3 pb-3 md:flex-1 md:flex-col md:gap-0 md:overflow-y-auto md:pb-4">
          {groups.map((g, gi) => (
            <div key={g.heading ?? gi} className="flex gap-1 md:mb-4 md:flex-col md:gap-0.5">
              {g.heading && <div className="hidden px-3 pt-1 pb-1 text-[11px] font-medium tracking-wide text-muted/80 md:block">{g.heading}</div>}
              {g.items.map((item) => (
                <NavLink key={item.href} href={item.href} icon={item.icon} badge={item.badge === "exceptions" ? stats?.exceptions_high : undefined}>
                  {item.label}
                </NavLink>
              ))}
            </div>
          ))}
          {can(user.role, "leads.manage") && (
            <a
              href="/enquiry"
              target="_blank"
              className="rounded-lg px-3 py-2 text-sm whitespace-nowrap text-muted hover:bg-surface-2 hover:text-text md:mb-2"
            >
              Patient form ↗
            </a>
          )}
        </nav>

        <div className="space-y-3 border-t border-border/80 px-4 py-4 text-xs text-muted">
          <div className="hidden space-y-1.5 md:block">
            <StatusDot ok={health.database} label="Database" />
            <StatusDot ok={health.worker_online} label={health.worker_online ? "Worker online" : "Worker offline"} />
            <div className="pt-1 text-[11px]">
              {e.AI_PROVIDER === "rules" ? "Rules engine" : e.AI_MODEL} · {e.MESSAGING_PROVIDER === "mock" ? "demo phone" : "WhatsApp Cloud"}
            </div>
          </div>
          <div className="flex items-center justify-between gap-2 rounded-xl bg-surface-2 p-2">
            <a href="/account" className="flex min-w-0 items-center gap-2.5 hover:text-text">
              <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-primary-soft text-sm font-semibold text-primary-strong">
                {user.full_name.replace(/^(dr\.?|mr\.?|ms\.?|mrs\.?)\s+/i, "").charAt(0).toUpperCase()}
              </span>
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium text-text">{user.full_name}</span>
                <span className="block">{ROLE_LABEL[user.role]}</span>
              </span>
            </a>
            <form action={logoutAction}>
              <button className="rounded-lg px-2 py-1 hover:bg-surface hover:text-primary">Sign out</button>
            </form>
          </div>
        </div>
      </aside>

      <main id="content" className="min-w-0 flex-1 px-4 py-7 md:px-10">
        <div className="mx-auto max-w-[1280px]">
          {!health.worker_online && health.database && can(user.role, "exceptions.manage") && (
            <div className="mb-5 rounded-xl border border-warn/30 bg-warn-soft px-4 py-2.5 text-sm text-warn">
              The background worker is not running, so new enquiries will wait in the queue. Start it with <code className="font-mono">npm run worker</code>.
            </div>
          )}
          {children}
        </div>
      </main>
    </div>
  );
}

function StatusDot({ ok, label }: { ok: boolean; label: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className={`h-2 w-2 rounded-full ${ok ? "live-dot bg-ok text-ok" : "bg-danger"}`} />
      {label}
    </div>
  );
}
