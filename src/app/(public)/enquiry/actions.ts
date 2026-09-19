"use server";

import { headers } from "next/headers";
import { intakeLead } from "@/server/workflows/lead-intake";

export type EnquiryState =
  | { status: "idle" }
  | { status: "error"; errors: Record<string, string>; values: Record<string, string> }
  | { status: "done"; reference: string };

// Simple per-IP limiter. Adequate for one app instance; behind a load balancer use the proxy's rate limiting.
const WINDOW_MS = 10 * 60_000;
const MAX_PER_WINDOW = 5;
const hits = new Map<string, number[]>();

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 10_000) hits.clear();
  return recent.length > MAX_PER_WINDOW;
}

export async function submitEnquiry(_prev: EnquiryState, form: FormData): Promise<EnquiryState> {
  const values = Object.fromEntries(
    ["full_name", "phone", "department", "preferred_date", "enquiry_text"].map((k) => [k, String(form.get(k) ?? "")]),
  );

  // Honeypot: real people never see or fill this field.
  if (String(form.get("website") ?? "")) return { status: "done", reference: "HOSP-RECEIVED" };

  const h = await headers();
  const ip = h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip") || "local";
  if (rateLimited(ip)) {
    return { status: "error", errors: { _: "Too many enquiries from this connection. Please call the hospital." }, values };
  }

  const result = await intakeLead({
    ...values,
    department: values.department || null,
    source: "website",
    consent: form.get("consent") === "on",
  });
  if (!result.ok) return { status: "error", errors: result.errors, values };
  return { status: "done", reference: result.correlationId };
}
