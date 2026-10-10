import { z } from "zod";
import { audit } from "@/lib/audit";
import { many, one, type Db } from "@/lib/db";
import { newId } from "@/lib/ids";
import { estimatedDateOfBirth } from "@/lib/age";
import { normalizeIndianPhone } from "@/lib/phone";
import { isValidDateString, istDateString } from "@/lib/time";

const text = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === "" ? null : v))
    .nullable()
    .optional();

export const BLOOD_GROUPS = ["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-"] as const;
export const GENDERS = ["female", "male", "other"] as const;

export const RegisterPatientSchema = z
  .object({
    full_name: z.string().trim().min(2, "Enter the patient's full name.").max(120),
    phone: z.string().trim().min(1, "Enter a mobile number."),
    gender: z.enum(GENDERS, { error: "Choose a gender." }),
    date_of_birth: z.string().trim().optional(),
    age: z.string().trim().optional(),
    city: text(80),
    address: text(300),
    blood_group: z.enum(BLOOD_GROUPS).nullable().optional(),
    allergies: text(500),
    insurance_provider: text(120),
    insurance_policy_no: text(60),
    emergency_contact_name: text(120),
    emergency_contact_phone: text(30),
    // 'yes' and 'no' record an answer; 'unknown' leaves whatever is already on file.
    whatsapp_consent: z.enum(["yes", "no", "unknown"]).default("unknown"),
  })
  .superRefine((v, ctx) => {
    const today = istDateString();
    if (v.date_of_birth) {
      if (!isValidDateString(v.date_of_birth) || v.date_of_birth > today) {
        ctx.addIssue({ code: "custom", path: ["date_of_birth"], message: "Enter a valid date of birth." });
      }
    } else if (v.age) {
      const n = Number(v.age);
      if (!Number.isInteger(n) || n < 0 || n > 120) ctx.addIssue({ code: "custom", path: ["age"], message: "Enter an age between 0 and 120." });
    } else {
      ctx.addIssue({ code: "custom", path: ["age"], message: "Enter the age or the date of birth." });
    }
  });

export type RegisterPatientInput = z.input<typeof RegisterPatientSchema>;

export interface PatientRecord {
  patient_id: string;
  uhid: string;
  full_name: string;
  phone: string;
  gender: "female" | "male" | "other" | null;
  date_of_birth: string | null;
  dob_estimated: boolean;
  city: string | null;
  address: string | null;
  blood_group: string | null;
  allergies: string | null;
  insurance_provider: string | null;
  insurance_policy_no: string | null;
  emergency_contact_name: string | null;
  emergency_contact_phone: string | null;
  consent_status: "granted" | "denied" | "unknown";
  created_at: Date;
}

const COLUMNS = `patient_id, uhid, full_name, phone, gender, date_of_birth, dob_estimated, city, address, blood_group, allergies,
  insurance_provider, insurance_policy_no, emergency_contact_name, emergency_contact_phone, consent_status, created_at`;

export type RegisterResult =
  | { ok: true; patient: PatientRecord; created: boolean }
  | { ok: false; errors: Record<string, string> };

/**
 * Registers a patient at the front desk. A phone number that is already on file (a WhatsApp
 * enquiry, an earlier visit) resolves to that patient, and only blank fields are filled in:
 * the desk never silently rewrites what the patient or an earlier visit recorded.
 */
export async function registerPatient(db: Db, raw: RegisterPatientInput): Promise<RegisterResult> {
  const parsed = RegisterPatientSchema.safeParse(raw);
  if (!parsed.success) {
    const errors: Record<string, string> = {};
    for (const issue of parsed.error.issues) errors[String(issue.path[0] ?? "_")] ??= issue.message;
    return { ok: false, errors };
  }
  const v = parsed.data;
  const phone = normalizeIndianPhone(v.phone);
  if (!phone) return { ok: false, errors: { phone: "Enter a valid 10-digit Indian mobile number." } };

  const dob = v.date_of_birth || estimatedDateOfBirth(Number(v.age));
  const estimated = !v.date_of_birth;
  const consent = v.whatsapp_consent === "yes" ? "granted" : v.whatsapp_consent === "no" ? "denied" : null;

  const row = await one<PatientRecord & { inserted: boolean }>(
    db,
    `INSERT INTO patients (patient_id, full_name, phone, source, consent_status, gender, date_of_birth, dob_estimated, city, address,
                           blood_group, allergies, insurance_provider, insurance_policy_no, emergency_contact_name, emergency_contact_phone)
     VALUES ($1, $2, $3, 'front_desk', COALESCE($4, 'unknown'), $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
     ON CONFLICT (phone) DO UPDATE SET
       consent_status          = COALESCE($4, patients.consent_status),
       gender                  = COALESCE(patients.gender, EXCLUDED.gender),
       date_of_birth           = COALESCE(patients.date_of_birth, EXCLUDED.date_of_birth),
       dob_estimated           = CASE WHEN patients.date_of_birth IS NULL THEN EXCLUDED.dob_estimated ELSE patients.dob_estimated END,
       city                    = COALESCE(patients.city, EXCLUDED.city),
       address                 = COALESCE(patients.address, EXCLUDED.address),
       blood_group             = COALESCE(patients.blood_group, EXCLUDED.blood_group),
       allergies               = COALESCE(patients.allergies, EXCLUDED.allergies),
       insurance_provider      = COALESCE(patients.insurance_provider, EXCLUDED.insurance_provider),
       insurance_policy_no     = COALESCE(patients.insurance_policy_no, EXCLUDED.insurance_policy_no),
       emergency_contact_name  = COALESCE(patients.emergency_contact_name, EXCLUDED.emergency_contact_name),
       emergency_contact_phone = COALESCE(patients.emergency_contact_phone, EXCLUDED.emergency_contact_phone),
       updated_at = now()
     RETURNING ${COLUMNS}, (xmax = 0) AS inserted`,
    [
      newId("PAT"), v.full_name, phone, consent, v.gender, dob, estimated, v.city ?? null, v.address ?? null,
      v.blood_group ?? null, v.allergies ?? null, v.insurance_provider ?? null, v.insurance_policy_no ?? null,
      v.emergency_contact_name ?? null, v.emergency_contact_phone ?? null,
    ],
  );
  const { inserted, ...patient } = row!;

  await audit(db, {
    workflow: "clinic",
    actor: "staff",
    action: inserted ? "patient.registered" : "patient.matched",
    recordId: patient.patient_id,
    details: { uhid: patient.uhid },
  });
  return { ok: true, patient, created: inserted };
}

export interface PatientSummary {
  patient_id: string;
  uhid: string;
  full_name: string;
  phone: string;
  gender: string | null;
  date_of_birth: string | null;
  dob_estimated: boolean;
  city: string | null;
  allergies: string | null;
  last_visit_date: string | null;
}

/**
 * Finds patients by name, UHID or any part of the mobile number. With no query it returns the
 * most recently active, which is what the desk wants on an empty search box.
 */
export async function searchPatients(db: Db, query: string, limit = 15): Promise<PatientSummary[]> {
  const q = query.trim().slice(0, 80);
  const digits = q.replace(/\D/g, "");
  const select = `
    SELECT p.patient_id, p.uhid, p.full_name, p.phone, p.gender, p.date_of_birth, p.dob_estimated, p.city, p.allergies,
           (SELECT max(v.visit_date) FROM visits v WHERE v.patient_id = p.patient_id AND v.status <> 'cancelled') AS last_visit_date
      FROM patients p`;

  if (!q) return many(db, `${select} ORDER BY p.updated_at DESC LIMIT $1`, [limit]);

  const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  return many(
    db,
    `${select}
      WHERE p.full_name ILIKE $1
         OR p.uhid ILIKE $1
         OR ($2 <> '' AND length($2) >= 3 AND p.phone LIKE '%' || $2 || '%')
      ORDER BY (upper(p.uhid) = upper($3)) DESC, (p.phone LIKE '%' || $2) DESC, p.updated_at DESC
      LIMIT $4`,
    [like, digits, q, limit],
  );
}

export async function getPatient(db: Db, patientId: string): Promise<PatientRecord | undefined> {
  return one<PatientRecord>(db, `SELECT ${COLUMNS} FROM patients WHERE patient_id = $1`, [patientId]);
}
