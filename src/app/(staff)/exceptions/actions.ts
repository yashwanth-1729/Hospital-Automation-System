"use server";

import { revalidatePath } from "next/cache";
import { audit } from "@/lib/audit";
import { tx } from "@/lib/db";
import { resolveException } from "@/lib/exceptions";
import { requireStaff } from "@/server/auth/guard";

export async function resolveExceptionAction(formData: FormData) {
  await requireStaff("exceptions.manage");
  const id = String(formData.get("exception_id") ?? "");
  const note = String(formData.get("note") ?? "").trim().slice(0, 1000) || "Resolved by staff";
  if (!id) return;
  await tx(async (c) => {
    const done = await resolveException(c, id, note);
    if (done) {
      const row = await c.query<{ correlation_id: string | null }>(`SELECT correlation_id FROM exceptions WHERE exception_id = $1`, [id]);
      await audit(c, {
        workflow: "system",
        actor: "staff",
        action: "exception.resolved",
        recordId: id,
        correlationId: row.rows[0]?.correlation_id,
        details: { note },
      });
    }
  });
  revalidatePath("/exceptions");
  revalidatePath("/");
}
