import { NextResponse } from "next/server";
import { getSystemHealth } from "@/server/queries";

export async function GET() {
  const h = await getSystemHealth();
  const ok = h.database && h.worker_online;
  return NextResponse.json({ ok, ...h }, { status: ok ? 200 : 503 });
}
