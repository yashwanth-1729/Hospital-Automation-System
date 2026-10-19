import { many, one, type Db } from "@/lib/db";
import { env } from "@/lib/env";
import { addDays, formatSlot, istAt, istDateString } from "@/lib/time";
import { getFunnel, getResponseTimes } from "@/server/reports";
import { hospitalAnalytics } from "@/server/clinic/analytics";
import { occupancy } from "@/server/ipd/admissions";
import { stockOverview } from "@/server/pharmacy/stock";
import { imagingCounts } from "@/server/radiology/imaging";

/** "Rahul Sharma" becomes "Rahul S.": enough to recognise a patient, not enough to identify them elsewhere. */
function shortName(full: string): string {
  const parts = full.trim().split(/\s+/);
  return parts.length > 1 ? `${parts[0]} ${parts[parts.length - 1]![0]}.` : (parts[0] ?? "");
}

export interface CalendarEntry {
  date: string;
  time: string;
  doctor: string;
  department: string;
  patient: string;
  status: string;
}

/** Booked appointments between two IST dates, inclusive. The data behind the calendar API and the assistant. */
export async function calendar(db: Db, from: string, to: string): Promise<CalendarEntry[]> {
  const rows = await many<{ slot_start: Date; doctor: string; department: string; patient: string; status: string; attendance: string }>(
    db,
    `SELECT a.slot_start, d.full_name AS doctor, dep.name AS department, p.full_name AS patient, a.status, a.attendance_status AS attendance
       FROM appointments a
       JOIN doctors d ON d.doctor_id = a.doctor_id
       JOIN departments dep ON dep.department_id = a.department_id
       JOIN patients p ON p.patient_id = a.patient_id
      WHERE a.slot_start >= $1 AND a.slot_start < $2 AND a.status <> 'cancelled'
      ORDER BY a.slot_start`,
    [istAt(from, 0), istAt(addDays(to, 1), 0)],
  );
  return rows.map((r) => ({
    date: istDateString(r.slot_start),
    time: formatSlot(r.slot_start).split(", ").slice(-1)[0]!,
    doctor: r.doctor,
    department: r.department,
    patient: shortName(r.patient),
    status: r.attendance === "pending" ? "booked" : r.attendance.replace("_", " "),
  }));
}

const FEATURES = `Clevo is a hospital operating system plus WhatsApp automation. Screens: Dashboard; Reception (register patients, queue, tokens, check-in); Enquiries (leads from the website and ads); Appointments; Wards (beds, admit, transfer, discharge); Consultation (doctor: vitals, case sheet, prescription with allergy check, imaging orders); Radiology (worklist and reports); Pharmacy (dispensing, batch stock, expiry); Billing (invoices, payments, refunds, day book); Discharges, Follow-ups, Feedback, Exceptions (tasks the system will not decide alone); Analytics; Reports; Audits; Staff accounts. Roles: administrator, receptionist, doctor, nurse, pharmacist, billing, radiology. Patient WhatsApp messages are fixed approved templates. Emergencies and medical questions always go to a person.`;

/** Everything the assistant is allowed to know, as plain numbers and short lists. No phone numbers, no emails. */
export async function buildHospitalContext(db: Db): Promise<string> {
  const today = istDateString();
  const [a, funnel, response, beds, stock, imaging, queue, unpaid, exceptions, inpatients, staff, leadsOpen] = await Promise.all([
    hospitalAnalytics(db, 14),
    getFunnel(30),
    getResponseTimes(30),
    occupancy(db),
    stockOverview(db),
    imagingCounts(db),
    one<{ waiting: number; with_doctor: number; seen: number }>(
      db,
      `SELECT count(*) FILTER (WHERE status = 'waiting')::int AS waiting, count(*) FILTER (WHERE status = 'in_consultation')::int AS with_doctor,
              count(*) FILTER (WHERE status = 'completed')::int AS seen FROM visits WHERE visit_date = $1`,
      [today],
    ),
    many<{ invoice_number: string; patient: string; balance: number; due: string | null }>(
      db,
      `SELECT i.invoice_number, p.full_name AS patient, (i.total - i.amount_paid)::float AS balance, i.due_date AS due
         FROM invoices i JOIN patients p ON p.patient_id = i.patient_id
        WHERE i.status IN ('issued', 'partially_paid') ORDER BY (i.total - i.amount_paid) DESC LIMIT 8`,
    ),
    one<{ high: number; medium: number; low: number }>(
      db,
      `SELECT count(*) FILTER (WHERE severity = 'high')::int AS high, count(*) FILTER (WHERE severity = 'medium')::int AS medium,
              count(*) FILTER (WHERE severity = 'low')::int AS low FROM exceptions WHERE status = 'open'`,
    ),
    many<{ patient: string; bed: string; ward: string; doctor: string; since: Date }>(
      db,
      `SELECT p.full_name AS patient, b.label AS bed, w.name AS ward, d.full_name AS doctor, a.admitted_at AS since
         FROM admissions a JOIN patients p ON p.patient_id = a.patient_id JOIN doctors d ON d.doctor_id = a.doctor_id
         JOIN bed_stays s ON s.admission_id = a.admission_id AND s.ended_at IS NULL
         JOIN beds b ON b.bed_id = s.bed_id JOIN wards w ON w.ward_id = s.ward_id
        WHERE a.status = 'admitted' ORDER BY a.admitted_at`,
    ),
    many<{ role: string; n: number }>(db, `SELECT role, count(*)::int AS n FROM staff_users WHERE active AND user_id <> 'USR-DEMO-HISTORY' GROUP BY role`),
    one<{ n: number }>(db, `SELECT count(*)::int AS n FROM leads WHERE status IN ('new', 'needs_review', 'no_slot')`),
  ]);
  const cal = await calendar(db, today, addDays(today, 6));
  const byDay = new Map<string, CalendarEntry[]>();
  for (const e of cal) byDay.set(e.date, [...(byDay.get(e.date) ?? []), e]);

  const inr = (n: number) => `Rs ${Math.round(n).toLocaleString("en-IN")}`;
  const lines: string[] = [
    `TODAY: ${today} (India time).`,
    "",
    `OPD last ${a.days} days: ${a.visits.completed} patients seen (${a.visits.walk_in} walk-in, ${a.visits.appointment} booked), ${a.visits.cancelled} left without being seen. Average wait ${a.wait.average_minutes ?? "n/a"} min, longest ${a.wait.longest_minutes ?? "n/a"} min.`,
    `Patients per day: ${a.visits_by_day.map((d) => `${d.date.slice(5)}=${d.value}`).join(", ")}.`,
    `Today's queue: ${queue?.waiting ?? 0} waiting, ${queue?.with_doctor ?? 0} with a doctor, ${queue?.seen ?? 0} seen.`,
    `Doctors (patients seen, avg wait): ${a.doctors.map((d) => `${d.name} (${d.department}) ${d.seen}, ${d.avg_wait ?? "n/a"} min`).join("; ")}.`,
    `Departments by visits: ${a.departments.map((d) => `${d.department} ${d.visits}`).join(", ")}.`,
    `Common diagnoses: ${a.diagnoses.map((d) => `${d.diagnosis} ${d.n}`).join(", ")}.`,
    "",
    `Money last ${a.days} days: billed ${inr(a.money.billed)}, collected ${inr(a.money.collected)}, refunded ${inr(a.money.refunded)}, pharmacy sales ${inr(a.money.pharmacy_sales)}. Outstanding on all unpaid invoices: ${inr(a.money.outstanding)}.`,
    `Collected per day: ${a.collected_by_day.map((d) => `${d.date.slice(5)}=${inr(d.value)}`).join(", ")}.`,
    `Largest unpaid invoices: ${unpaid.map((u) => `${u.invoice_number} ${shortName(u.patient)} ${inr(u.balance)}${u.due ? ` due ${u.due}` : ""}`).join("; ") || "none"}.`,
    "",
    `Beds: ${beds.map((w) => `${w.name} ${w.occupied}/${w.total} occupied, ${w.available} free, ${w.cleaning} cleaning, ${w.maintenance} maintenance`).join("; ")}.`,
    `Inpatients now (${inpatients.length}): ${inpatients.map((i) => `${shortName(i.patient)} in ${i.ward} ${i.bed} under ${i.doctor} since ${istDateString(i.since)}`).join("; ") || "none"}.`,
    `Inpatients admitted ${a.inpatients.admitted}, discharged ${a.inpatients.discharged} in ${a.days} days; average stay ${a.inpatients.average_stay_days ?? "n/a"} days.`,
    "",
    `Pharmacy stock: out of stock: ${stock.filter((s) => s.status === "out").map((s) => s.name).join(", ") || "none"}. Low: ${stock.filter((s) => s.status === "low").map((s) => `${s.name} (${s.available} left, reorder at ${s.reorder_level})`).join(", ") || "none"}. Expired units on the shelf: ${stock.filter((s) => s.expired > 0).map((s) => `${s.name} ${s.expired}`).join(", ") || "none"}. Expiring within 60 days: ${stock.filter((s) => s.expiring_soon > 0).map((s) => `${s.name} ${s.expiring_soon}`).join(", ") || "none"}. Top medicines dispensed: ${a.medicines.map((m) => `${m.name} ${m.quantity}`).join(", ")}.`,
    `Radiology: ${imaging.ordered} waiting, ${imaging.in_progress} in progress, ${imaging.urgent_open} urgent open, ${imaging.reported_today} reported in the last day.`,
    "",
    `Enquiries (last 30 days): ${funnel.enquiries} received, ${funnel.auto_booked} booked automatically, ${funnel.staff_booked} by staff, ${funnel.needs_review} needed a person, ${funnel.no_slot} had no slot, ${funnel.no_shows} no-shows, ${funnel.attended} attended. Conversion ${funnel.conversion_rate ?? "n/a"}%, automation ${funnel.automation_rate ?? "n/a"}%. Median first response ${response.median_seconds ?? "n/a"} s. Open enquiries needing attention: ${leadsOpen?.n ?? 0}.`,
    `Open tasks (Exceptions): ${exceptions?.high ?? 0} high, ${exceptions?.medium ?? 0} medium, ${exceptions?.low ?? 0} low.`,
    `Active staff accounts: ${staff.map((s) => `${s.role} ${s.n}`).join(", ")}.`,
    "",
    "CALENDAR (booked appointments, next 7 days):",
    ...[...Array(7).keys()].map((i) => {
      const d = addDays(today, i);
      const list = byDay.get(d) ?? [];
      return `${d}: ${list.length} appointment(s)${list.length ? ` - ${list.slice(0, 14).map((e) => `${e.time} ${e.patient} with ${e.doctor}`).join("; ")}${list.length > 14 ? " ..." : ""}` : ""}`;
    }),
  ];
  return lines.join("\n").slice(0, 14000);
}

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

const RULES = `You are Clevo's assistant for the hospital administrator. Answer ONLY from the DATA and FEATURES below. If the data does not contain the answer, say so plainly and say where in Clevo to look. Be brief and specific: numbers first, then one sentence of meaning. Use Indian rupee amounts as "Rs 12,500". You have read-only access: you cannot change anything, so tell the administrator which screen to use. Never give medical advice or diagnose; for anything clinical say that a doctor must decide. Patient names appear only as first name and initial. Do not invent figures.`;

/** Asks the configured AI model. With no key configured it says so, instead of guessing. */
export async function askAssistant(db: Db, question: string, history: ChatTurn[] = [], fetchImpl: typeof fetch = fetch, cfg: Partial<ReturnType<typeof env>> = {}): Promise<{ answer: string; ai: boolean }> {
  const q = question.trim().slice(0, 800);
  if (!q) return { answer: "Ask me something about the hospital: patients, money, stock, beds, the calendar.", ai: false };
  const e = { ...env(), ...cfg };
  if (e.AI_PROVIDER !== "openai_compatible" || !e.AI_API_KEY) {
    return { answer: "The assistant needs an AI key to be configured on the server (AI_PROVIDER and AI_API_KEY).", ai: false };
  }
  const context = await buildHospitalContext(db);
  const messages = [
    { role: "system", content: `${RULES}\n\nFEATURES:\n${FEATURES}\n\nDATA:\n${context}` },
    ...history.slice(-6).map((t) => ({ role: t.role, content: t.content.slice(0, 1500) })),
    { role: "user", content: q },
  ];
  let res: Response;
  try {
    res = await fetchImpl(`${e.AI_BASE_URL.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${e.AI_API_KEY}`, "x-title": "Clevo" },
      body: JSON.stringify({ model: e.AI_MODEL, temperature: 0.2, max_tokens: 700, reasoning: { enabled: false }, messages }),
      signal: AbortSignal.timeout(e.AI_TIMEOUT_MS),
    });
  } catch {
    return { answer: "I could not reach the AI service just now. Please try again in a moment.", ai: false };
  }
  if (!res.ok) return { answer: "The AI service returned an error. Please try again in a moment.", ai: false };
  const data = (await res.json().catch(() => null)) as { choices?: { message?: { content?: string | null } }[] } | null;
  const answer = data?.choices?.[0]?.message?.content?.trim();
  return answer ? { answer, ai: true } : { answer: "I did not get an answer back. Please try again.", ai: false };
}
