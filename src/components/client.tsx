"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Icons, type IconName } from "./icons";

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

export function NavLink({
  href,
  children,
  badge,
  icon,
}: {
  href: string;
  children: React.ReactNode;
  badge?: number;
  icon?: IconName;
}) {
  const pathname = usePathname();
  const active = href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);
  const Glyph = icon ? Icons[icon] : null;
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={`group relative flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors ${
        active ? "bg-primary-soft font-medium text-primary-strong" : "text-muted hover:bg-surface-2 hover:text-text"
      }`}
    >
      {/* The marker grows in from the edge when a page becomes current. */}
      <span
        aria-hidden
        className={`absolute top-1/2 left-0 h-5 w-[3px] -translate-y-1/2 rounded-r-full bg-primary transition-all duration-300 ${
          active ? "scale-y-100 opacity-100" : "scale-y-0 opacity-0"
        }`}
      />
      {Glyph && (
        <span className={`shrink-0 transition-transform duration-200 ${active ? "" : "group-hover:translate-x-0.5"}`}>
          <Glyph />
        </span>
      )}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {!!badge && <span className="num rounded-full bg-danger px-1.5 text-xs font-semibold text-white">{badge}</span>}
    </Link>
  );
}

/**
 * Counts up to a figure when it first appears, and from the old figure to the new one when it
 * changes, so a live dashboard visibly moves instead of silently swapping digits.
 */
export function AnimatedNumber({ value, format }: { value: number; format?: (n: number) => string }) {
  const [shown, setShown] = useState(value);
  const from = useRef(0);
  const first = useRef(true);

  useEffect(() => {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const start = first.current ? 0 : from.current;
    first.current = false;
    if (reduce || start === value) {
      from.current = value;
      return;
    }
    const began = performance.now();
    const duration = 650;
    let frame = 0;
    const tick = (now: number) => {
      const t = Math.min(1, (now - began) / duration);
      const eased = 1 - Math.pow(1 - t, 4);
      const current = start + (value - start) * eased;
      setShown(Number.isInteger(value) ? Math.round(current) : current);
      from.current = current;
      if (t < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [value]);

  return <>{format ? format(shown) : shown}</>;
}
