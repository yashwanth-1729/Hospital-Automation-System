"use client";

import { useState } from "react";
import { bookLeadAction } from "./actions";

export interface DepartmentSlots {
  departmentId: string;
  name: string;
  slots: { slot_id: string; label: string }[];
}

/** Lets reception book a lead the automation could not decide on, without leaving the page. */
export function BookLead({ leadId, departments, preselected }: { leadId: string; departments: DepartmentSlots[]; preselected: string | null }) {
  const [departmentId, setDepartmentId] = useState(preselected ?? departments[0]?.departmentId ?? "");
  const slots = departments.find((d) => d.departmentId === departmentId)?.slots ?? [];

  return (
    <form action={bookLeadAction} className="space-y-3 p-4">
      <input type="hidden" name="lead_id" value={leadId} />
      <p className="text-sm text-muted">This enquiry is waiting for a person. Pick a department and slot to book it.</p>
      <select
        aria-label="Department"
        value={departmentId}
        onChange={(e) => setDepartmentId(e.target.value)}
        className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm"
      >
        {departments.map((d) => (
          <option key={d.departmentId} value={d.departmentId}>
            {d.name}
          </option>
        ))}
      </select>
      <select name="slot_id" required defaultValue="" className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm">
        <option value="" disabled>
          {slots.length ? "Choose a slot…" : "No open slots in this department"}
        </option>
        {slots.map((s) => (
          <option key={s.slot_id} value={s.slot_id}>
            {s.label}
          </option>
        ))}
      </select>
      <button
        disabled={!slots.length}
        className="w-full rounded-lg bg-primary px-3 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50"
      >
        Book and confirm on WhatsApp
      </button>
    </form>
  );
}
