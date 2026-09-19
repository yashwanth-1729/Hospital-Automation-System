/**
 * Normalizes an Indian mobile number to E.164 (+91XXXXXXXXXX).
 * Returns null when the input is not a plausible Indian mobile number.
 */
export function normalizeIndianPhone(input: string): string | null {
  let digits = input.replace(/\D/g, "");
  if (digits.length === 13 && digits.startsWith("091")) digits = digits.slice(1);
  if (digits.length === 12 && digits.startsWith("91")) digits = digits.slice(2);
  if (digits.length === 11 && digits.startsWith("0")) digits = digits.slice(1);
  if (digits.length !== 10 || !/^[6-9]/.test(digits)) return null;
  return `+91${digits}`;
}

/** +91 98765 43210 -> +91 ••••• •3210 for dashboards that do not need the full number. */
export function maskPhone(e164: string): string {
  return `${e164.slice(0, 3)} ••••• •${e164.slice(-4)}`;
}
