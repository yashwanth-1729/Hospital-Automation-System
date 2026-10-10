/**
 * Small, dependency-free charts. Server-rendered markup with a CSS rise animation, so a
 * dashboard feels alive without shipping a charting library.
 */

export interface Bar {
  label: string;
  value: number;
  hint?: string;
}

export function BarChart({
  data,
  format = (n) => String(n),
  height = 140,
  tone = "primary",
}: {
  data: Bar[];
  format?: (n: number) => string;
  height?: number;
  tone?: "primary" | "ok" | "info";
}) {
  const max = Math.max(1, ...data.map((d) => d.value));
  const color = tone === "ok" ? "bg-ok" : tone === "info" ? "bg-info" : "bg-primary";
  const total = data.reduce((n, d) => n + d.value, 0);

  return (
    <figure className="w-full" aria-label={`Bar chart, total ${format(total)}`}>
      <div className="flex items-end gap-1" style={{ height }}>
        {data.map((d, i) => {
          const pct = (d.value / max) * 100;
          return (
            <div key={d.label} className="group relative flex h-full min-w-0 flex-1 items-end" title={`${d.label}: ${format(d.value)}${d.hint ? ` · ${d.hint}` : ""}`}>
              <div
                className={`bar-rise w-full rounded-t ${color} ${d.value === 0 ? "opacity-20" : "opacity-80 group-hover:opacity-100"} transition-opacity`}
                style={{ height: `${Math.max(pct, d.value === 0 ? 2 : 4)}%`, animationDelay: `${i * 25}ms` }}
              />
            </div>
          );
        })}
      </div>
      <figcaption className="mt-1 flex justify-between text-[11px] text-muted">
        <span>{data[0]?.label}</span>
        <span>{data[data.length - 1]?.label}</span>
      </figcaption>
    </figure>
  );
}

/** A ranked list with proportional bars: top diagnoses, top medicines, doctor load. */
export function RankedList({ rows, format = (n) => String(n) }: { rows: { label: string; value: number; sub?: string }[]; format?: (n: number) => string }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  if (rows.length === 0) return <p className="px-4 py-8 text-center text-sm text-muted">Nothing in this period yet.</p>;
  return (
    <ul className="space-y-3 p-4">
      {rows.map((r, i) => (
        <li key={r.label}>
          <div className="flex items-baseline justify-between gap-3 text-sm">
            <span className="min-w-0 truncate font-medium">{r.label}</span>
            <span className="num shrink-0 text-muted">{format(r.value)}</span>
          </div>
          <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-2">
            <div className="bar-grow h-full rounded-full bg-primary/80" style={{ width: `${(r.value / max) * 100}%`, animationDelay: `${i * 40}ms` }} />
          </div>
          {r.sub && <div className="mt-0.5 text-xs text-muted">{r.sub}</div>}
        </li>
      ))}
    </ul>
  );
}
