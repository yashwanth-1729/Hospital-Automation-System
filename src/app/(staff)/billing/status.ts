import type { InvoiceStatus } from "@/server/billing/invoices";

export const STATUS: Record<InvoiceStatus, { tone: "neutral" | "ok" | "warn" | "danger" | "info"; label: string }> = {
  draft: { tone: "neutral", label: "Draft" },
  issued: { tone: "warn", label: "Unpaid" },
  partially_paid: { tone: "info", label: "Part paid" },
  paid: { tone: "ok", label: "Paid" },
  void: { tone: "danger", label: "Void" },
};

/** Indian digit grouping: ₹1,23,456.00 */
export const inr = (n: number) => `₹${n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
