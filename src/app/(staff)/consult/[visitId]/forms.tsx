"use client";

import { useActionState, useMemo, useState } from "react";
import { Card } from "@/components/ui";
import { allergyConflicts, FREQUENCIES, FREQUENCY_CODES, quantityFor, TIMINGS, type Frequency, type Timing } from "@/lib/prescribing";
import { addendumAction, recordVitalsAction, saveConsultationAction, type FormState } from "../actions";

const IDLE: FormState = { status: "idle" };
const field = "mt-1 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-primary aria-[invalid=true]:border-danger";
const small = "mt-1 w-full rounded-lg border border-border bg-surface px-2 py-1.5 text-sm outline-none focus:border-primary aria-[invalid=true]:border-danger";

function Notice({ state }: { state: FormState }) {
  if (state.status === "error") return <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">{state.message}</p>;
  if (state.status === "ok") return <p role="status" className="rounded-lg bg-ok-soft px-3 py-2 text-sm text-ok">{state.message}</p>;
  return null;
}

// --- vitals ----------------------------------------------------------------------------------

const VITAL_FIELDS = ["bp_systolic", "bp_diastolic", "pulse", "temperature_c", "spo2", "resp_rate", "weight_kg", "height_cm", "notes"] as const;

export function VitalsForm({ visitId }: { visitId: string }) {
  const empty = Object.fromEntries(VITAL_FIELDS.map((f) => [f, ""])) as Record<(typeof VITAL_FIELDS)[number], string>;
  const [values, setValues] = useState(empty);
  const [state, action, pending] = useActionState(async (prev: FormState, form: FormData) => {
    const result = await recordVitalsAction(prev, form);
    if (result.status === "ok") setValues(empty);
    return result;
  }, IDLE);
  const errors = state.status === "error" ? (state.errors ?? {}) : {};
  const input = (name: (typeof VITAL_FIELDS)[number], label: string, props: React.InputHTMLAttributes<HTMLInputElement> = {}) => (
    <label className="block text-xs font-medium">
      {label}
      <input
        name={name}
        inputMode="decimal"
        value={values[name]}
        onChange={(ev) => setValues((v) => ({ ...v, [name]: ev.target.value }))}
        aria-invalid={!!errors[name]}
        className={small}
        {...props}
      />
    </label>
  );
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="visit_id" value={visitId} />
      <Notice state={state} />
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {input("bp_systolic", "BP upper", { placeholder: "120" })}
        {input("bp_diastolic", "BP lower", { placeholder: "80" })}
        {input("pulse", "Pulse /min")}
        {input("temperature_c", "Temp °C", { placeholder: "36.8" })}
        {input("spo2", "SpO₂ %")}
        {input("resp_rate", "Resp. /min")}
        {input("weight_kg", "Weight kg")}
        {input("height_cm", "Height cm")}
      </div>
      <div className="flex items-center gap-3">
        <input
          name="notes"
          value={values.notes}
          onChange={(ev) => setValues((v) => ({ ...v, notes: ev.target.value }))}
          placeholder="Note (optional)"
          maxLength={500}
          className={`${small} max-w-xs`}
        />
        <button disabled={pending} className="rounded-lg border border-primary px-3 py-1.5 text-sm font-medium text-primary hover:bg-primary-soft disabled:opacity-60">
          {pending ? "Saving…" : "Record vitals"}
        </button>
      </div>
    </form>
  );
}

// --- consultation ------------------------------------------------------------------------------

interface Row {
  key: number;
  medicine_name: string;
  dose_units: string;
  frequency: string;
  duration_days: string;
  timing: string;
  quantity: string;
  instructions: string;
}

export interface ConsultInitial {
  chief_complaint: string;
  history: string;
  examination: string;
  diagnosis: string;
  advice: string;
  follow_up_date: string;
  allergy_override_reason: string;
  items: Omit<Row, "key">[];
}

const BLANK: Omit<Row, "key"> = { medicine_name: "", dose_units: "1", frequency: "BD", duration_days: "5", timing: "after_food", quantity: "", instructions: "" };

export function ConsultForm({
  visitId,
  allergies,
  medicines,
  initial,
}: {
  visitId: string;
  allergies: string | null;
  medicines: { name: string; generic_name: string; unit: string }[];
  initial?: ConsultInitial;
}) {
  const [state, action, pending] = useActionState(saveConsultationAction, IDLE);
  const errors = state.status === "error" ? (state.errors ?? {}) : {};
  const [rows, setRows] = useState<Row[]>(() =>
    (initial?.items.length ? initial.items : [BLANK]).map((r, i) => ({ ...r, key: i })),
  );
  const [nextKey, setNextKey] = useState(rows.length);
  // Controlled, because a form action resets plain fields when it returns: a rejected
  // submission must never wipe what the doctor has written.
  const [sheet, setSheet] = useState({
    chief_complaint: initial?.chief_complaint ?? "",
    history: initial?.history ?? "",
    examination: initial?.examination ?? "",
    diagnosis: initial?.diagnosis ?? "",
    advice: initial?.advice ?? "",
    follow_up_date: initial?.follow_up_date ?? "",
    allergy_override_reason: initial?.allergy_override_reason ?? "",
  });
  const bind = (name: keyof typeof sheet) => ({
    name,
    value: sheet[name],
    onChange: (ev: React.ChangeEvent<HTMLTextAreaElement | HTMLInputElement>) => setSheet((s) => ({ ...s, [name]: ev.target.value })),
  });

  const update = (key: number, patch: Partial<Row>) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const add = () => {
    setRows((rs) => [...rs, { ...BLANK, key: nextKey }]);
    setNextKey((k) => k + 1);
  };
  const remove = (key: number) => setRows((rs) => (rs.length > 1 ? rs.filter((r) => r.key !== key) : [{ ...BLANK, key }]));

  const byName = useMemo(() => new Map(medicines.map((m) => [m.name.toLowerCase(), m])), [medicines]);

  // The same check the server enforces, run as the doctor types so the warning is immediate.
  const conflicts = useMemo(
    () =>
      allergyConflicts(
        allergies,
        rows.map((r) => ({ medicine_name: r.medicine_name, generic_name: byName.get(r.medicine_name.trim().toLowerCase())?.generic_name })),
      ).filter((c) => rows[c.index]?.medicine_name.trim()),
    [allergies, rows, byName],
  );
  const flagged = new Set(conflicts.map((c) => c.index));

  return (
    <form action={action} className="space-y-6">
      <input type="hidden" name="visit_id" value={visitId} />
      <Notice state={state} />

      <Card title="Case sheet">
        <div className="space-y-4 p-4">
          <label className="block text-sm font-medium">
            Reason for visit
            <textarea {...bind("chief_complaint")} rows={2} aria-invalid={!!errors.chief_complaint} className={field} />
            {errors.chief_complaint && <span className="mt-1 block text-xs text-danger">{errors.chief_complaint}</span>}
          </label>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block text-sm font-medium">
              History
              <textarea {...bind("history")} rows={3} className={field} />
            </label>
            <label className="block text-sm font-medium">
              Examination
              <textarea {...bind("examination")} rows={3} className={field} />
            </label>
          </div>
          <label className="block text-sm font-medium">
            Diagnosis
            <textarea {...bind("diagnosis")} rows={2} aria-invalid={!!errors.diagnosis} className={field} />
            {errors.diagnosis && <span className="mt-1 block text-xs text-danger">{errors.diagnosis}</span>}
          </label>
          <label className="block text-sm font-medium">
            Advice for the patient
            <textarea {...bind("advice")} rows={2} className={field} />
          </label>
        </div>
      </Card>

      <Card title="Prescription">
        <div className="space-y-3 p-4">
          <datalist id="formulary">
            {medicines.map((m) => (
              <option key={m.name} value={m.name}>{m.generic_name}</option>
            ))}
          </datalist>
          {errors._ && <p className="text-sm text-danger">{errors._}</p>}

          {rows.map((r, i) => {
            const med = byName.get(r.medicine_name.trim().toLowerCase());
            const qty = quantityFor({
              doseUnits: Number(r.dose_units) || 0,
              frequency: (r.frequency || "OD") as Frequency,
              durationDays: Number(r.duration_days) || 0,
              explicit: Number(r.quantity) || null,
            });
            const e = (name: string) => errors[`items.${i}.${name}`];
            return (
              <div key={r.key} className={`rounded-lg border p-3 ${flagged.has(i) ? "border-danger bg-danger-soft/40" : "border-border"}`}>
                <div className="grid gap-2 sm:grid-cols-12">
                  <label className="text-xs font-medium sm:col-span-5">
                    Medicine
                    <input
                      name={`items.${i}.medicine_name`}
                      list="formulary"
                      value={r.medicine_name}
                      onChange={(ev) => update(r.key, { medicine_name: ev.target.value })}
                      autoComplete="off"
                      aria-invalid={!!e("medicine_name")}
                      className={small}
                    />
                    {e("medicine_name") && <span className="text-danger">{e("medicine_name")}</span>}
                  </label>
                  <label className="text-xs font-medium sm:col-span-2">
                    Dose{med && med.unit !== "unit" ? ` (${med.unit})` : ""}
                    <input
                      name={`items.${i}.dose_units`}
                      inputMode="decimal"
                      value={r.dose_units}
                      onChange={(ev) => update(r.key, { dose_units: ev.target.value })}
                      aria-invalid={!!e("dose_units")}
                      className={small}
                    />
                  </label>
                  <label className="text-xs font-medium sm:col-span-3">
                    How often
                    <select name={`items.${i}.frequency`} value={r.frequency} onChange={(ev) => update(r.key, { frequency: ev.target.value })} className={small}>
                      {FREQUENCY_CODES.map((f) => (
                        <option key={f} value={f}>{f} · {FREQUENCIES[f].label}</option>
                      ))}
                    </select>
                  </label>
                  <label className="text-xs font-medium sm:col-span-2">
                    Days
                    <input
                      name={`items.${i}.duration_days`}
                      inputMode="numeric"
                      value={r.duration_days}
                      onChange={(ev) => update(r.key, { duration_days: ev.target.value })}
                      aria-invalid={!!e("duration_days")}
                      className={small}
                    />
                    {e("duration_days") && <span className="text-danger">{e("duration_days")}</span>}
                  </label>
                </div>
                <div className="mt-2 grid gap-2 sm:grid-cols-12">
                  <label className="text-xs font-medium sm:col-span-3">
                    Timing
                    <select name={`items.${i}.timing`} value={r.timing} onChange={(ev) => update(r.key, { timing: ev.target.value })} className={small}>
                      {(Object.keys(TIMINGS) as Timing[]).map((t) => (
                        <option key={t} value={t}>{TIMINGS[t]}</option>
                      ))}
                    </select>
                  </label>
                  {r.frequency === "SOS" && (
                    <label className="text-xs font-medium sm:col-span-2">
                      Quantity
                      <input
                        name={`items.${i}.quantity`}
                        inputMode="numeric"
                        value={r.quantity}
                        onChange={(ev) => update(r.key, { quantity: ev.target.value })}
                        aria-invalid={!!e("quantity")}
                        className={small}
                      />
                      {e("quantity") && <span className="text-danger">{e("quantity")}</span>}
                    </label>
                  )}
                  <label className={`text-xs font-medium ${r.frequency === "SOS" ? "sm:col-span-5" : "sm:col-span-7"}`}>
                    Instructions
                    <input name={`items.${i}.instructions`} value={r.instructions} onChange={(ev) => update(r.key, { instructions: ev.target.value })} maxLength={200} className={small} />
                  </label>
                  <div className="flex items-end justify-between gap-2 text-xs sm:col-span-2">
                    <span className="num pb-2 text-muted">{qty > 0 && r.medicine_name.trim() ? `Qty ${qty}` : ""}</span>
                    <button type="button" onClick={() => remove(r.key)} className="rounded-lg border border-border px-2 py-1.5 hover:border-danger hover:text-danger">
                      Remove
                    </button>
                  </div>
                </div>
                {flagged.has(i) && (
                  <p role="alert" className="mt-2 text-sm font-medium text-danger">
                    Allergy: the patient is recorded as allergic to {conflicts.find((c) => c.index === i)?.allergen}.
                  </p>
                )}
                {/* Hidden when not SOS so a stale quantity never overrides the computed one. */}
                {r.frequency !== "SOS" && <input type="hidden" name={`items.${i}.quantity`} value="" />}
              </div>
            );
          })}

          <button type="button" onClick={add} className="rounded-lg border border-dashed border-border px-3 py-1.5 text-sm text-muted hover:border-primary hover:text-primary">
            + Add medicine
          </button>

          {conflicts.length > 0 && (
            <label className="block rounded-lg border border-danger bg-danger-soft p-3 text-sm font-medium text-danger">
              Why is this safe for this patient?
              <textarea
                {...bind("allergy_override_reason")}
                rows={2}
                aria-invalid={!!errors.allergy_override_reason}
                className={`${field} font-normal text-text`}
              />
              {errors.allergy_override_reason && <span className="mt-1 block text-xs">{errors.allergy_override_reason}</span>}
              <span className="mt-1 block text-xs font-normal">Recorded on the prescription and visible to the pharmacist.</span>
            </label>
          )}
        </div>
      </Card>

      <Card title="Follow-up">
        <div className="p-4">
          <label className="block max-w-xs text-sm font-medium">
            Review on
            <input type="date" {...bind("follow_up_date")} aria-invalid={!!errors.follow_up_date} className={field} />
            {errors.follow_up_date && <span className="mt-1 block text-xs text-danger">{errors.follow_up_date}</span>}
            <span className="mt-1 block text-xs font-normal text-muted">The patient gets a WhatsApp reminder the day before.</span>
          </label>
        </div>
      </Card>

      <div className="flex flex-wrap items-center gap-3">
        <button
          name="intent"
          value="finish"
          disabled={pending}
          className="rounded-lg bg-primary px-5 py-2.5 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-60"
        >
          {pending ? "Saving…" : "Finish consultation"}
        </button>
        <button
          name="intent"
          value="draft"
          disabled={pending}
          className="rounded-lg border border-border px-4 py-2.5 text-sm font-medium hover:border-primary hover:text-primary disabled:opacity-60"
        >
          Save draft
        </button>
        <span className="text-xs text-muted">Finishing locks the record and sends the prescription to the pharmacy.</span>
      </div>
    </form>
  );
}

export function AddendumForm({ visitId, consultationId }: { visitId: string; consultationId: string }) {
  const [note, setNote] = useState("");
  const [state, action, pending] = useActionState(async (prev: FormState, form: FormData) => {
    const result = await addendumAction(prev, form);
    if (result.status === "ok") setNote("");
    return result;
  }, IDLE);
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="visit_id" value={visitId} />
      <input type="hidden" name="consultation_id" value={consultationId} />
      <Notice state={state} />
      <textarea name="note" value={note} onChange={(ev) => setNote(ev.target.value)} rows={3} required maxLength={2000} placeholder="Anything learned after the consultation. The original record stays as it was." className={field} />
      <button disabled={pending} className="rounded-lg border border-primary px-3 py-1.5 text-sm font-medium text-primary hover:bg-primary-soft disabled:opacity-60">
        {pending ? "Saving…" : "Add note"}
      </button>
    </form>
  );
}
