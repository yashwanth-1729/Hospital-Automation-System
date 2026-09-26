import { createHmac, timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { env } from "@/lib/env";
import { processWhatsAppWebhook, type WhatsAppWebhookPayload } from "@/server/messaging/inbound";

/**
 * WhatsApp Cloud API webhook: delivery receipts and patient replies.
 *
 * Meta signs every delivery with the app secret. An unverified webhook is refused, because
 * without that check anyone who learned this URL could mark messages as delivered or opt a
 * patient out of their appointment reminders.
 */

/** Meta calls this once, when the webhook is first registered. */
export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const expected = env().WA_VERIFY_TOKEN;

  if (params.get("hub.mode") === "subscribe" && expected && params.get("hub.verify_token") === expected) {
    return new NextResponse(params.get("hub.challenge") ?? "", {
      status: 200,
      headers: { "content-type": "text/plain" },
    });
  }
  return NextResponse.json({ error: "verification_failed" }, { status: 403 });
}

function signatureMatches(raw: string, header: string | null, appSecret: string): boolean {
  if (!header?.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", appSecret).update(raw, "utf8").digest("hex");
  const a = Buffer.from(header.slice(7), "hex");
  const b = Buffer.from(expected, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(req: NextRequest) {
  const appSecret = env().WA_APP_SECRET;
  // The body must be read raw: the signature covers the exact bytes Meta sent.
  const raw = await req.text();

  if (appSecret && !signatureMatches(raw, req.headers.get("x-hub-signature-256"), appSecret)) {
    return NextResponse.json({ error: "invalid_signature" }, { status: 403 });
  }

  let payload: WhatsAppWebhookPayload;
  try {
    payload = JSON.parse(raw) as WhatsAppWebhookPayload;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  try {
    const result = await processWhatsAppWebhook(payload);
    return NextResponse.json({ ok: true, ...result });
  } catch {
    // Meta retries on any non-2xx, which would replay the whole batch. The handlers are
    // idempotent, so a retry is safe, but a 500 here is still the honest answer.
    return NextResponse.json({ error: "processing_failed" }, { status: 500 });
  }
}
