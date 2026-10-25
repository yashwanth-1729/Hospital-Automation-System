import { timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { env } from "@/lib/env";
import { handleHmsEvent } from "@/server/care/hms";

function secretMatches(given: string | null, expected: string): boolean {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Events from the hospital's existing HMS or lab system: visits and lab results. Always needs the secret. */
export async function POST(req: NextRequest) {
  const secret = env().WEBHOOK_SECRET;
  if (!secret) return NextResponse.json({ error: "not_configured" }, { status: 503 });
  if (!secretMatches(req.headers.get("x-webhook-secret"), secret)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const result = await handleHmsEvent(body);
  if (!result.ok) return NextResponse.json({ error: "validation_failed", fields: result.errors }, { status: 422 });
  return NextResponse.json(result, { status: 202 });
}
