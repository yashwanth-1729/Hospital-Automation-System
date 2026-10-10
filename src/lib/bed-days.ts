import { istDateString } from "./time";

function dayNumber(date: string): number {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return Math.floor(Date.UTC(y, m - 1, d) / 86_400_000);
}

/**
 * Chargeable days for one stay in one bed: each IST calendar day on which the patient was in it.
 *
 * A day belongs to the bed the patient ended it in, so a mid-day transfer is charged once, to
 * the new bed. A stay that began and was transferred on the same day therefore costs nothing,
 * and a patient admitted and discharged on one day is charged that one day.
 */
export function stayDays(opts: { startedAt: Date; endedAt: Date | null; endedReason: "transfer" | "discharge" | null; now?: Date }): number {
  const start = dayNumber(istDateString(opts.startedAt));
  const end = dayNumber(istDateString(opts.endedAt ?? opts.now ?? new Date()));
  const inclusive = opts.endedReason === "transfer" ? end - 1 : end;
  return Math.max(0, inclusive - start + 1);
}
