"use client";

import { useState } from "react";
import { cancelAppointmentAction, rescheduleAppointmentAction } from "./actions";

export interface SlotOption {
  slot_id: string;
  label: string;
}

/** Cancel / reschedule controls. Kept collapsed so the table stays readable. */
export function RowActions({ appointmentId, slots }: { appointmentId: string; slots: SlotOption[] }) {
  const [open, setOpen] = useState<"none" | "cancel" | "reschedule">("none");

  if (open === "none") {
    return (
      <div className="flex gap-1.5">
        <button onClick={() => setOpen("reschedule")} className="rounded-lg border border-border px-2 py-1 text-xs hover:border-primary hover:text-primary">
          Reschedule
        </button>
        <button onClick={() => setOpen("cancel")} className="rounded-lg border border-border px-2 py-1 text-xs text-muted hover:border-danger hover:text-danger">
          Cancel
        </button>
      </div>
    );
  }

  if (open === "cancel") {
    return (
      <form action={cancelAppointmentAction} className="flex flex-wrap items-center gap-1.5">
        <input type="hidden" name="appointment_id" value={appointmentId} />
        <input name="reason" placeholder="Reason" aria-label="Cancellation reason" className="w-32 rounded-lg border border-border bg-surface px-2 py-1 text-xs" />
        <button className="rounded-lg bg-danger px-2 py-1 text-xs font-medium text-white">Confirm</button>
        <button type="button" onClick={() => setOpen("none")} className="text-xs text-muted hover:text-text">
          Back
        </button>
      </form>
    );
  }

  return (
    <form action={rescheduleAppointmentAction} className="flex flex-wrap items-center gap-1.5">
      <input type="hidden" name="appointment_id" value={appointmentId} />
      <select name="slot_id" required className="max-w-44 rounded-lg border border-border bg-surface px-2 py-1 text-xs" defaultValue="">
        <option value="" disabled>
          Choose a slot…
        </option>
        {slots.map((s) => (
          <option key={s.slot_id} value={s.slot_id}>
            {s.label}
          </option>
        ))}
      </select>
      <button className="rounded-lg bg-primary px-2 py-1 text-xs font-medium text-white">Move</button>
      <button type="button" onClick={() => setOpen("none")} className="text-xs text-muted hover:text-text">
        Back
      </button>
    </form>
  );
}
