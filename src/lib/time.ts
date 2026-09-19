export const TIMEZONE = "Asia/Kolkata";
const IST_OFFSET = "+05:30"; // India has no daylight saving time.

/** 'YYYY-MM-DD' for the given instant in IST. */
export function istDateString(d: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

/** [start, end) instants covering an IST calendar day. */
export function istDayRange(date: string): [Date, Date] {
  const start = new Date(`${date}T00:00:00${IST_OFFSET}`);
  if (Number.isNaN(start.getTime())) throw new Error(`Invalid date: ${date}`);
  return [start, new Date(start.getTime() + 24 * 60 * 60 * 1000)];
}

/** An IST wall-clock time as an instant, e.g. istAt('2026-09-21', 10, 30). */
export function istAt(date: string, hour: number, minute = 0): Date {
  const hh = String(hour).padStart(2, "0");
  const mm = String(minute).padStart(2, "0");
  return new Date(`${date}T${hh}:${mm}:00${IST_OFFSET}`);
}

export function addDays(date: string, days: number): string {
  const [start] = istDayRange(date);
  return istDateString(new Date(start.getTime() + days * 86400000 + 12 * 3600000));
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Patient-facing format, e.g. 'Mon, 21 Sep 2026, 10:30 AM'. Built explicitly so ICU/locale updates never change it. */
export function formatSlot(d: Date): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: TIMEZONE,
      weekday: "short",
      day: "numeric",
      month: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    })
      .formatToParts(d)
      .map((p) => [p.type, p.value]),
  );
  return `${parts.weekday}, ${parts.day} ${MONTHS[Number(parts.month) - 1]} ${parts.year}, ${parts.hour}:${parts.minute} ${parts.dayPeriod?.toUpperCase()}`;
}

/** Staff-facing short format, e.g. '20 Sep, 12:45 AM'. */
export function formatDateTime(d: Date | string | null | undefined): string {
  if (!d) return "—";
  const full = formatSlot(new Date(d)); // 'Sun, 20 Sep 2026, 12:45 AM'
  const [, dayMonthYear, time] = full.split(", ");
  return `${dayMonthYear!.split(" ").slice(0, 2).join(" ")}, ${time}`;
}

export function isValidDateString(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(s);
}
