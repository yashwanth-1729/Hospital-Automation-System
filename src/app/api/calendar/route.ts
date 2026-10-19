import { NextResponse } from "next/server";
import { pool } from "@/lib/db";
import { can } from "@/lib/rbac";
import { addDays, isValidDateString, istDateString } from "@/lib/time";
import { currentStaff } from "@/server/auth/guard";
import { calendar } from "@/server/ai/assistant";

export const dynamic = "force-dynamic";

/** GET /api/calendar?from=YYYY-MM-DD&to=YYYY-MM-DD : booked appointments, for administrators and the front desk. */
export async function GET(req: Request) {
  const user = await currentStaff();
  if (!user) return NextResponse.json({ ok: false, error: "unauthenticated" }, { status: 401 });
  if (!can(user.role, "assistant.use") && !can(user.role, "appointments.manage")) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }
  const url = new URL(req.url);
  const today = istDateString();
  const from = url.searchParams.get("from") ?? today;
  const to = url.searchParams.get("to") ?? addDays(from, 6);
  if (!isValidDateString(from) || !isValidDateString(to) || to < from || to > addDays(from, 62)) {
    return NextResponse.json({ ok: false, error: "invalid_range", message: "Use dates as YYYY-MM-DD, at most 62 days apart." }, { status: 400 });
  }
  return NextResponse.json({ ok: true, from, to, appointments: await calendar(pool(), from, to) });
}
