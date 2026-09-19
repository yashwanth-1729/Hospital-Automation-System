import { timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { env } from "@/lib/env";
import { recordDischarge } from "@/server/workflows/discharge";

function secretMatches(given: string | null, expected: string): boolean {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Discharge event from the hospital's HMS.
 * The follow-up date must be one a clinician approved; this endpoint never infers one.
 */
export async function POST(req: NextRequest) {
  const secret = env().WEBHOOK_SECRET;
  if (secret && !secretMatches(req.headers.get("x-webhook-secret"), secret)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const result = await recordDischarge(body);
  if (!result.ok) return NextResponse.json({ error: "validation_failed", fields: result.errors }, { status: 422 });

  return NextResponse.json(
    { discharge_id: result.dischargeId, correlation_id: result.correlationId, duplicate: result.duplicate, status: "queued" },
    { status: result.duplicate ? 200 : 202 },
  );
}
