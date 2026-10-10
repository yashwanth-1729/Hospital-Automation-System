import { addDays, istDateString } from "./time";

/** Whole years between a 'YYYY-MM-DD' birth date and a 'YYYY-MM-DD' day (default: today in IST). */
export function ageInYears(dateOfBirth: string, on: string = istDateString()): number {
  const [by, bm, bd] = dateOfBirth.split("-").map(Number) as [number, number, number];
  const [y, m, d] = on.split("-").map(Number) as [number, number, number];
  let age = y - by;
  if (m < bm || (m === bm && d < bd)) age -= 1;
  return Math.max(0, age);
}

/**
 * A birth date for someone who only knows their age. Mid-year, so the estimate is within six
 * months either way, and always flagged as estimated where it is stored and shown.
 */
export function estimatedDateOfBirth(ageYears: number, today: string = istDateString()): string {
  const year = Number(today.slice(0, 4)) - ageYears;
  const candidate = `${String(year).padStart(4, "0")}-07-01`;
  // A newborn's "mid-year" can fall after today; never produce a birth date in the future.
  return candidate > today ? addDays(today, -1) : candidate;
}

/** '34 y' for staff screens; under a year shows months, under a month shows days. */
export function formatAge(dateOfBirth: string | null | undefined, estimated = false, on: string = istDateString()): string {
  if (!dateOfBirth) return "—";
  const years = ageInYears(dateOfBirth, on);
  const approx = estimated ? "~" : "";
  if (years >= 1) return `${approx}${years} y`;
  const [by, bm, bd] = dateOfBirth.split("-").map(Number) as [number, number, number];
  const [y, m, d] = on.split("-").map(Number) as [number, number, number];
  let months = (y - by) * 12 + (m - bm);
  if (d < bd) months -= 1;
  if (months >= 1) return `${approx}${months} mo`;
  const days = Math.max(0, Math.round((Date.UTC(y, m - 1, d) - Date.UTC(by, bm - 1, bd)) / 86400000));
  return `${days} d`;
}
