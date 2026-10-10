/**
 * Prescription arithmetic and the allergy safety net. Pure functions, so the rules a doctor
 * relies on are tested without a database.
 */

export const FREQUENCIES = {
  OD: { label: "Once a day", perDay: 1 },
  BD: { label: "Twice a day", perDay: 2 },
  TDS: { label: "Three times a day", perDay: 3 },
  QID: { label: "Four times a day", perDay: 4 },
  HS: { label: "At bedtime", perDay: 1 },
  SOS: { label: "Only if needed", perDay: 0 },
} as const;
export type Frequency = keyof typeof FREQUENCIES;
export const FREQUENCY_CODES = Object.keys(FREQUENCIES) as Frequency[];

export const TIMINGS = {
  any: "Any time",
  before_food: "Before food",
  after_food: "After food",
  with_food: "With food",
} as const;
export type Timing = keyof typeof TIMINGS;

/**
 * How many units to dispense. SOS has no fixed schedule, so the doctor states the quantity;
 * everything else is dose x doses per day x days, rounded up (you cannot dispense half a strip).
 */
export function quantityFor(opts: { doseUnits: number; frequency: Frequency; durationDays: number; explicit?: number | null }): number {
  const { doseUnits, frequency, durationDays, explicit } = opts;
  if (frequency === "SOS") return explicit && explicit > 0 ? Math.ceil(explicit) : 0;
  return Math.max(1, Math.ceil(doseUnits * FREQUENCIES[frequency].perDay * durationDays));
}

/** 'Paracetamol 500 mg - 1 tablet, twice a day for 5 days (after food)' for patient-facing lines. */
export function describeItem(i: {
  medicine_name: string;
  dose_units: number;
  unit?: string;
  frequency: Frequency;
  duration_days: number;
  timing: Timing;
}): string {
  const unit = i.unit && i.unit !== "unit" ? ` ${i.unit}` : "";
  const when = i.timing === "any" ? "" : ` (${TIMINGS[i.timing].toLowerCase()})`;
  return `${i.medicine_name}: ${i.dose_units}${unit}, ${FREQUENCIES[i.frequency].label.toLowerCase()} for ${i.duration_days} day${i.duration_days === 1 ? "" : "s"}${when}`;
}

/**
 * Allergy classes name drugs by what they contain. A patient allergic to "penicillin" must be
 * warned about amoxicillin even though the word never appears on the prescription.
 */
const ALLERGY_CLASSES: Record<string, string[]> = {
  penicillin: ["penicillin", "amoxicillin", "ampicillin", "cloxacillin", "piperacillin", "clavulan"],
  penicillins: ["penicillin", "amoxicillin", "ampicillin", "cloxacillin", "piperacillin", "clavulan"],
  sulfa: ["sulfa", "sulpha", "sulfamethoxazole", "cotrimoxazole", "co-trimoxazole", "sulfasalazine"],
  sulpha: ["sulfa", "sulpha", "sulfamethoxazole", "cotrimoxazole", "co-trimoxazole", "sulfasalazine"],
  nsaid: ["ibuprofen", "diclofenac", "aceclofenac", "naproxen", "aspirin", "ketorolac", "nimesulide", "etoricoxib"],
  nsaids: ["ibuprofen", "diclofenac", "aceclofenac", "naproxen", "aspirin", "ketorolac", "nimesulide", "etoricoxib"],
  cephalosporin: ["cef", "ceph"],
  cephalosporins: ["cef", "ceph"],
  macrolide: ["azithromycin", "clarithromycin", "erythromycin"],
  macrolides: ["azithromycin", "clarithromycin", "erythromycin"],
  quinolone: ["floxacin"],
  fluoroquinolone: ["floxacin"],
  statin: ["statin"],
  statins: ["statin"],
};

const NO_ALLERGY = new Set(["none", "nil", "no", "nka", "nkda", "no known allergies", "no known drug allergies", "not known", "na", "n/a"]);

/** The individual allergens in a free-text allergy field: 'Penicillin, sulfa; and egg'. */
export function allergens(text: string | null | undefined): string[] {
  if (!text) return [];
  return text
    .toLowerCase()
    .split(/[,;\n/]|\band\b/)
    .map((t) => t.trim().replace(/\.$/, ""))
    .filter((t) => t.length >= 3 && !NO_ALLERGY.has(t));
}

export interface AllergyConflict {
  index: number;
  medicine: string;
  allergen: string;
}

/** Items whose name, or active ingredient, matches something the patient is recorded as allergic to. */
export function allergyConflicts(
  allergyText: string | null | undefined,
  items: { medicine_name: string; generic_name?: string | null }[],
): AllergyConflict[] {
  const list = allergens(allergyText);
  if (list.length === 0) return [];
  const conflicts: AllergyConflict[] = [];
  items.forEach((item, index) => {
    const haystack = `${item.medicine_name} ${item.generic_name ?? ""}`.toLowerCase();
    for (const allergen of list) {
      const needles = ALLERGY_CLASSES[allergen] ?? [allergen];
      if (needles.some((n) => haystack.includes(n))) {
        conflicts.push({ index, medicine: item.medicine_name, allergen });
        break;
      }
    }
  });
  return conflicts;
}

/** BMI to one decimal, or null when either measurement is missing or implausible. */
export function bmi(weightKg: number | null, heightCm: number | null): number | null {
  if (!weightKg || !heightCm || heightCm < 50) return null;
  const m = heightCm / 100;
  return Math.round((weightKg / (m * m)) * 10) / 10;
}
