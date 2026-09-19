import { z } from "zod";

export const NEEDS_HUMAN_REVIEW = "NEEDS_HUMAN_REVIEW";

export const ENQUIRY_TYPES = [
  "appointment_booking",
  "general_enquiry",
  "clinical_question",
  "emergency",
  "billing",
  "other",
] as const;
export type EnquiryType = (typeof ENQUIRY_TYPES)[number];

export interface DepartmentOption {
  id: string;
  name: string;
}

/** Deliberately excludes name and phone: the AI never needs patient identifiers. */
export interface LeadClassificationInput {
  enquiryText: string;
  departmentSelected: string | null;
  source: string;
  departments: DepartmentOption[];
}

export interface LeadClassification {
  department: string; // a department id, or NEEDS_HUMAN_REVIEW
  enquiry_type: EnquiryType;
  priority_for_human_review: "normal" | "review";
  missing_information: string[];
  reason: string;
  emergency: boolean;
  safety_flags: string[];
  provider: string;
  model: string | null;
  prompt_version: string;
}

export interface LeadClassifier {
  readonly name: string;
  classify(input: LeadClassificationInput): Promise<LeadClassification>;
}

/** Shape the LLM must return. Validated before anything acts on it. */
export const LlmLeadOutputSchema = z.object({
  department: z.string().min(1),
  enquiry_type: z.enum(ENQUIRY_TYPES),
  priority_for_human_review: z.enum(["normal", "review"]),
  missing_information: z.array(z.string()).default([]),
  reason: z.string().default(""),
});
export type LlmLeadOutput = z.infer<typeof LlmLeadOutputSchema>;
