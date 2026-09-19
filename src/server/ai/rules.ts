import { checkSafety } from "./safety";
import { PROMPT_LEAD_VERSION } from "./prompts";
import {
  NEEDS_HUMAN_REVIEW,
  type DepartmentOption,
  type EnquiryType,
  type LeadClassification,
  type LeadClassificationInput,
  type LeadClassifier,
} from "./types";

/** Keyword hints per department id. Departments without hints can still be selected explicitly. */
const DEPARTMENT_KEYWORDS: Record<string, RegExp> = {
  cardiology: /\b(heart|cardiac|cardio\w*|palpitation\w*|blood pressure|bp|hypertension|ecg|echo|angiograph\w*)\b/i,
  dermatology: /\b(skin|acne|pimples?|rash(es)?|eczema|psoriasis|derma\w*|itch\w*|pigmentation|hair\s*fall|dandruff|warts?)\b/i,
  orthopedics: /\b(bones?|joints?|knee|back\s*pain|fracture|spine|shoulder|ortho\w*|sprain|arthritis|ligament|hip)\b/i,
  general_medicine: /\b(fever|cold|cough|general|check\s*-?up|diabetes|sugar|thyroid|weakness|infection|vomiting|physician)\b/i,
};

const BOOKING_INTENT = /\b(book|booking|appointment|consult\w*|visit|see (a|the) doctor|slot|checkup|check-up|milna)\b/i;
const BILLING_INTENT = /\b(bill|billing|payment|refund|insurance|cashless|tpa|invoice)\b/i;

export function resolveDepartment(value: string | null | undefined, departments: DepartmentOption[]): string | null {
  if (!value) return null;
  const v = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
  const match = departments.find((d) => d.id === v || d.name.toLowerCase().replace(/[\s-]+/g, "_") === v);
  return match?.id ?? null;
}

function departmentsMentioned(text: string, departments: DepartmentOption[]): string[] {
  return departments.filter((d) => DEPARTMENT_KEYWORDS[d.id]?.test(text)).map((d) => d.id);
}

export class RulesLeadClassifier implements LeadClassifier {
  readonly name = "rules";

  async classify(input: LeadClassificationInput): Promise<LeadClassification> {
    const safety = checkSafety(input.enquiryText);
    const selected = resolveDepartment(input.departmentSelected, input.departments);
    const mentioned = departmentsMentioned(input.enquiryText, input.departments);

    let department: string = NEEDS_HUMAN_REVIEW;
    let reason: string;
    const missing: string[] = [];

    if (selected && (mentioned.length === 0 || mentioned.includes(selected))) {
      department = selected;
      reason = "Department selected by patient and consistent with enquiry text.";
    } else if (selected) {
      reason = `Selected department "${selected}" conflicts with enquiry text (mentions: ${mentioned.join(", ")}).`;
    } else if (mentioned.length === 1) {
      department = mentioned[0]!;
      reason = "Department inferred from enquiry keywords.";
    } else if (mentioned.length > 1) {
      reason = `Enquiry mentions several departments (${mentioned.join(", ")}).`;
    } else {
      reason = "No department selected and none identifiable from the enquiry.";
      missing.push("department");
    }

    let enquiryType: EnquiryType;
    if (safety.emergency) enquiryType = "emergency";
    else if (safety.clinicalQuestion) enquiryType = "clinical_question";
    else if (BILLING_INTENT.test(input.enquiryText)) enquiryType = "billing";
    else if (BOOKING_INTENT.test(input.enquiryText) || selected) enquiryType = "appointment_booking";
    else enquiryType = "general_enquiry";

    const needsReview =
      safety.emergency ||
      safety.clinicalQuestion ||
      safety.urgency ||
      department === NEEDS_HUMAN_REVIEW ||
      enquiryType === "billing";

    return {
      department,
      enquiry_type: enquiryType,
      priority_for_human_review: needsReview ? "review" : "normal",
      missing_information: missing,
      reason: safety.flags.length ? `${reason} Safety flags: ${safety.flags.join(", ")}.` : reason,
      emergency: safety.emergency,
      safety_flags: safety.flags,
      provider: this.name,
      model: null,
      prompt_version: PROMPT_LEAD_VERSION,
    };
  }
}
