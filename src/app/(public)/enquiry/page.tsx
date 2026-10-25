import { connection } from "next/server";
import { env } from "@/lib/env";
import { addDays, istDateString } from "@/lib/time";
import { listDepartments } from "@/server/queries";
import { EnquiryForm } from "./form";

export const metadata = { title: "Book an appointment" };

export default async function EnquiryPage() {
  await connection();
  const departments = await listDepartments();
  const e = env();
  const today = istDateString();

  return (
    <div className="min-h-screen bg-gradient-to-b from-primary-soft to-bg">
      <div className="mx-auto max-w-xl px-4 py-10">
        <header className="mb-6 text-center">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/clevo-logo.png" alt="" width={56} height={56} className="logo-pop mx-auto mb-3 h-14 w-14" />
          <h1 className="text-2xl font-semibold tracking-tight">{e.HOSPITAL_NAME}</h1>
          <p className="mt-1 text-sm text-muted">Request an appointment. We will confirm on WhatsApp.</p>
        </header>
        <div className="rounded-2xl border border-border bg-surface p-6 shadow-sm">
          <EnquiryForm departments={departments} minDate={today} maxDate={addDays(today, 60)} />
        </div>
        <p className="mt-6 text-center text-xs text-muted">Demo facility with fictional doctors. Do not enter real medical information.</p>
      </div>
    </div>
  );
}
