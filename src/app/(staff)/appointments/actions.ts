"use server";

import { revalidatePath } from "next/cache";
import { markAttendance, type Attendance } from "@/server/workflows/no-show";

const ALLOWED: Attendance[] = ["pending", "attended", "no_show"];

export async function markAttendanceAction(formData: FormData) {
  const appointmentId = String(formData.get("appointment_id") ?? "");
  const attendance = String(formData.get("attendance") ?? "") as Attendance;
  if (!appointmentId || !ALLOWED.includes(attendance)) return;

  await markAttendance(appointmentId, attendance, "staff");
  revalidatePath("/appointments");
  revalidatePath("/");
}
