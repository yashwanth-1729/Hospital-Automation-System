import { randomBytes } from "node:crypto";
import { istDateString } from "./time";

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford base32, no I/L/O/U

function randomCode(length: number): string {
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) out += ALPHABET[bytes[i]! % 32];
  return out;
}

/** Readable prefixed id, e.g. LEAD-7K2M9QX4TB. */
export function newId(prefix: string): string {
  return `${prefix}-${randomCode(10)}`;
}

/** Blueprint format: HOSP-YYYYMMDD-XXXXXX (date in IST). */
export function newCorrelationId(now = new Date()): string {
  return `HOSP-${istDateString(now).replaceAll("-", "")}-${randomCode(6)}`;
}

export const CORRELATION_ID_PATTERN = /^HOSP-\d{8}-[0-9A-Z]{6,}$/;
