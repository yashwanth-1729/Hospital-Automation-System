"use server";

import { revalidatePath } from "next/cache";
import { cancelAppointment, rescheduleAppointment } from "@/server/workflows/scheduling";
import { markAttendance, type Attendance } from "@/server/workflows/no-show";

const ALLOWED: Attendance[] = ["pending", "attended", "no_show"];

function refresh() {
  revalidatePath("/appointments");
  revalidatePath("/");
}

export async function markAttendanceAction(formData: FormData) {
  const appointmentId = String(formData.get("appointment_id") ?? "");
  const attendance = String(formData.get("attendance") ?? "") as Attendance;
  if (!appointmentId || !ALLOWED.includes(attendance)) return;

  await markAttendance(appointmentId, attendance, "staff");
  refresh();
}

export async function cancelAppointmentAction(formData: FormData) {
  const appointmentId = String(formData.get("appointment_id") ?? "");
  const reason = String(formData.get("reason") ?? "").trim().slice(0, 500) || "Cancelled by staff";
  if (!appointmentId) return;

  await cancelAppointment(appointmentId, reason, "staff");
  refresh();
}

export async function rescheduleAppointmentAction(formData: FormData) {
  const appointmentId = String(formData.get("appointment_id") ?? "");
  const slotId = String(formData.get("slot_id") ?? "");
  if (!appointmentId || !slotId) return;

  await rescheduleAppointment(appointmentId, slotId, "staff");
  refresh();
}
