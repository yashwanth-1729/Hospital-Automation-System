"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";

/** Re-fetches server data on an interval so dashboards stay live without websockets. */
export function AutoRefresh({ seconds = 5 }: { seconds?: number }) {
  const router = useRouter();
  useEffect(() => {
    const id = setInterval(() => {
      if (document.visibilityState === "visible") router.refresh();
    }, seconds * 1000);
    return () => clearInterval(id);
  }, [router, seconds]);
  return null;
}

export function NavLink({ href, children, badge }: { href: string; children: React.ReactNode; badge?: number }) {
  const pathname = usePathname();
  const active = href === "/" ? pathname === "/" : pathname.startsWith(href);
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={`flex items-center justify-between rounded-lg px-3 py-2 text-sm transition-colors ${
        active ? "bg-primary-soft font-medium text-primary" : "text-muted hover:bg-surface-2 hover:text-text"
      }`}
    >
      <span>{children}</span>
      {!!badge && <span className="num rounded-full bg-danger px-1.5 text-xs font-semibold text-white">{badge}</span>}
    </Link>
  );
}
