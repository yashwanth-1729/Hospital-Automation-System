import Link from "next/link";
import { connection } from "next/server";
import { Badge, Card, Empty, PageHeader, Td, Th } from "@/components/ui";
import { pool } from "@/lib/db";
import { formatDateOnly } from "@/lib/time";
import { requireStaff } from "@/server/auth/guard";
import { stockOverview } from "@/server/pharmacy/stock";
import { ReceiveForm } from "./forms";

export const metadata = { title: "Pharmacy stock" };

const VIEWS = [
  { key: "all", label: "All" },
  { key: "low", label: "Low or out" },
  { key: "expiring", label: "Expiring soon" },
  { key: "expired", label: "Expired" },
] as const;

export default async function StockPage({ searchParams }: { searchParams: Promise<{ view?: string; q?: string }> }) {
  await connection();
  await requireStaff("pharmacy.stock");
  const { view = "all", q = "" } = await searchParams;
  const all = await stockOverview(pool());

  const needle = q.trim().toLowerCase();
  const rows = all.filter((r) => {
    if (needle && !`${r.name} ${r.generic_name}`.toLowerCase().includes(needle)) return false;
    if (view === "low") return r.status !== "ok";
    if (view === "expiring") return r.expiring_soon > 0;
    if (view === "expired") return r.expired > 0;
    return true;
  });

  return (
    <>
      <PageHeader
        title="Stock"
        description="What is on the shelf, what is running low, and what is about to expire."
        actions={
          <Link href="/pharmacy" className="text-sm text-muted hover:text-text">
            Back to the counter
          </Link>
        }
      />

      <Card title="Receive stock" className="mb-6">
        <ReceiveForm medicines={all.map((m) => ({ medicine_id: m.medicine_id, name: m.name }))} />
      </Card>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        {VIEWS.map((v) => (
          <Link
            key={v.key}
            href={`/pharmacy/stock?view=${v.key}${q ? `&q=${encodeURIComponent(q)}` : ""}`}
            className={`rounded-lg border px-3 py-1.5 text-sm transition-colors ${
              view === v.key ? "border-primary bg-primary-soft text-primary" : "border-border text-muted hover:text-text"
            }`}
          >
            {v.label}
          </Link>
        ))}
        <form action="/pharmacy/stock" className="ml-auto">
          <input type="hidden" name="view" value={view} />
          <input
            name="q"
            defaultValue={q}
            placeholder="Search medicines"
            aria-label="Search medicines"
            className="rounded-lg border border-border bg-surface px-3 py-1.5 text-sm outline-none focus:border-primary"
          />
        </form>
      </div>

      <Card>
        {rows.length === 0 ? (
          <Empty>Nothing matches.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="border-b border-border">
                <tr>
                  <Th>Medicine</Th>
                  <Th>Available</Th>
                  <Th>Reorder at</Th>
                  <Th>Nearest expiry</Th>
                  <Th>Flags</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {rows.map((r) => (
                  <tr key={r.medicine_id} className="hover:bg-surface-2">
                    <Td>
                      <Link href={`/pharmacy/stock/${r.medicine_id}`} className="font-medium hover:text-primary">
                        {r.name}
                      </Link>
                      <div className="text-xs text-muted">
                        {r.generic_name} · {r.form}
                      </div>
                    </Td>
                    <Td className="num font-medium">{r.available}</Td>
                    <Td className="num text-muted">{r.reorder_level}</Td>
                    <Td className="num whitespace-nowrap text-sm">
                      {r.nearest_expiry ? formatDateOnly(r.nearest_expiry).split(", ").slice(1).join(", ") : "—"}
                    </Td>
                    <Td>
                      <div className="flex flex-wrap gap-1">
                        {r.status === "out" && <Badge tone="danger">Out of stock</Badge>}
                        {r.status === "low" && <Badge tone="warn">Low</Badge>}
                        {r.expiring_soon > 0 && <Badge tone="warn">{r.expiring_soon} expiring</Badge>}
                        {r.expired > 0 && <Badge tone="danger">{r.expired} expired</Badge>}
                      </div>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
