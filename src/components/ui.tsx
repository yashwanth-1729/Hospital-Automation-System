import Link from "next/link";
import type { ReactNode } from "react";
import { AnimatedNumber } from "./client";
import { Icons } from "./icons";

type Tone = "neutral" | "ok" | "warn" | "danger" | "info" | "primary";

const TONES: Record<Tone, string> = {
  neutral: "bg-surface-2 text-muted",
  ok: "bg-ok-soft text-ok",
  warn: "bg-warn-soft text-warn",
  danger: "bg-danger-soft text-danger",
  info: "bg-info-soft text-info",
  primary: "bg-primary-soft text-primary",
};

export function Badge({ tone = "neutral", children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span className={`inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium whitespace-nowrap ${TONES[tone]}`}>
      {children}
    </span>
  );
}

const LEAD_STATUS: Record<string, [Tone, string]> = {
  new: ["info", "Processing"],
  booked: ["ok", "Booked"],
  needs_review: ["warn", "Needs review"],
  no_slot: ["warn", "No slot"],
  closed: ["neutral", "Closed"],
};

export function LeadStatus({ status }: { status: string }) {
  const [tone, label] = LEAD_STATUS[status] ?? ["neutral", status];
  return <Badge tone={tone}>{label}</Badge>;
}

const MESSAGE_STATUS: Record<string, Tone> = {
  sending: "info",
  sent: "ok",
  delivered: "ok",
  read: "ok",
  failed: "danger",
  skipped: "neutral",
};

export function MessageStatus({ status }: { status: string }) {
  return <Badge tone={MESSAGE_STATUS[status] ?? "neutral"}>{status}</Badge>;
}

export function Severity({ level }: { level: string }) {
  const tone: Tone = level === "high" ? "danger" : level === "medium" ? "warn" : "neutral";
  return <Badge tone={tone}>{level}</Badge>;
}

export function Card({ title, action, children, className = "" }: { title?: ReactNode; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`rounded-2xl border border-border/80 bg-surface shadow-[var(--shadow-sm)] ${className}`}>
      {title && (
        <header className="flex items-center justify-between gap-3 border-b border-border/80 px-4 py-3">
          <h2 className="text-sm font-semibold tracking-tight">{title}</h2>
          {action}
        </header>
      )}
      {children}
    </section>
  );
}

export function Stat({ label, value, hint, tone = "neutral", href }: { label: string; value: ReactNode; hint?: ReactNode; tone?: Tone; href?: string }) {
  const accent = tone === "neutral" ? "text-text" : TONES[tone].split(" ")[1];
  const body = (
    <div
      className={`group h-full rounded-2xl border border-border/80 bg-surface p-4 shadow-[var(--shadow-sm)] transition-all duration-200 ${
        href ? "hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-[var(--shadow-md)]" : ""
      }`}
    >
      <div className="text-[13px] font-medium text-muted">{label}</div>
      <div className={`num mt-2 text-3xl leading-none font-semibold tracking-tight ${accent}`}>
        {typeof value === "number" ? <AnimatedNumber value={value} /> : value}
      </div>
      {hint && <div className="mt-2 text-xs text-muted">{hint}</div>}
    </div>
  );
  return href ? (
    <Link href={href} className="block h-full rounded-2xl">
      {body}
    </Link>
  ) : (
    body
  );
}

export function PageHeader({ title, description, actions }: { title: string; description?: string; actions?: ReactNode }) {
  return (
    <div className="mb-7 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        <h1 className="text-[26px] leading-tight font-semibold tracking-[-0.02em]">{title}</h1>
        {description && <p className="mt-1.5 max-w-2xl text-sm text-muted">{description}</p>}
      </div>
      {actions}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-3 px-4 py-12 text-center text-sm text-muted">
      <span className="grid h-10 w-10 place-items-center rounded-xl bg-surface-2 text-muted/80">
        <Icons.empty width={20} height={20} />
      </span>
      <div className="max-w-sm">{children}</div>
    </div>
  );
}

export function Th({ children, className = "" }: { children?: ReactNode; className?: string }) {
  return <th className={`px-4 py-2 text-left text-xs font-medium text-muted ${className}`}>{children}</th>;
}

export function Td({ children, className = "" }: { children?: ReactNode; className?: string }) {
  return <td className={`px-4 py-3 align-top text-sm ${className}`}>{children}</td>;
}

export function Mono({ children }: { children: ReactNode }) {
  return <span className="font-mono text-xs text-muted">{children}</span>;
}
