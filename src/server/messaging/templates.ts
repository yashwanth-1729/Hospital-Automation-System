/**
 * Patient-facing message templates.
 *
 * WhatsApp only allows business-initiated messages through templates pre-approved by Meta,
 * so patient messages are fixed text with variables - never free text written by an AI.
 * `params` order must match the {{1}}, {{2}}... placeholders registered with Meta.
 */

export interface TemplateDef {
  /** Name registered with the WhatsApp provider (lowercase, underscores). */
  providerName: string;
  category: "utility" | "marketing";
  params: readonly string[];
  render(v: Record<string, string>): string;
}

export const TEMPLATES = {
  ENQUIRY_ACK_01: {
    providerName: "enquiry_ack_01",
    category: "utility",
    params: ["patient_name", "hospital_name"],
    render: (v) =>
      `Hello ${v.patient_name}, thank you for contacting ${v.hospital_name}. ` +
      `Our team has received your enquiry and will contact you shortly to help you further.`,
  },
  EMERGENCY_REDIRECT_01: {
    providerName: "emergency_redirect_01",
    category: "utility",
    params: ["patient_name", "hospital_name", "emergency_number"],
    render: (v) =>
      `Hello ${v.patient_name}, we have received your message at ${v.hospital_name}. ` +
      `If this is a medical emergency, please call ${v.emergency_number} or go to the nearest emergency department immediately. ` +
      `Our team has been alerted and will contact you.`,
  },
  APPT_CONFIRM_01: {
    providerName: "appt_confirm_01",
    category: "utility",
    params: ["patient_name", "hospital_name", "department", "doctor_name", "slot", "appointment_id", "hospital_contact"],
    render: (v) =>
      `Hello ${v.patient_name}, your appointment at ${v.hospital_name} is confirmed.\n` +
      `Department: ${v.department}\nDoctor: ${v.doctor_name}\nDate & time: ${v.slot}\nBooking ID: ${v.appointment_id}\n` +
      `Please arrive 15 minutes early. To reschedule or cancel, call ${v.hospital_contact}.`,
  },
  APPT_RESCHEDULED_01: {
    providerName: "appt_rescheduled_01",
    category: "utility",
    params: ["patient_name", "hospital_name", "department", "doctor_name", "slot", "hospital_contact"],
    render: (v) =>
      `Hello ${v.patient_name}, your appointment at ${v.hospital_name} has been rescheduled.\n` +
      `Department: ${v.department}\nDoctor: ${v.doctor_name}\nNew date & time: ${v.slot}\n` +
      `If this time does not suit you, call ${v.hospital_contact}.`,
  },
  APPT_CANCELLED_01: {
    providerName: "appt_cancelled_01",
    category: "utility",
    params: ["patient_name", "hospital_name", "slot", "hospital_contact"],
    render: (v) =>
      `Hello ${v.patient_name}, your appointment at ${v.hospital_name} on ${v.slot} has been cancelled. ` +
      `To book a new time, call ${v.hospital_contact}.`,
  },
  NOSHOW_RECOVERY_01: {
    providerName: "noshow_recovery_01",
    category: "utility",
    params: ["patient_name", "hospital_name", "doctor_name", "missed_slot", "options", "hospital_contact"],
    render: (v) =>
      `Hello ${v.patient_name}, we missed you at ${v.hospital_name} for your appointment with ${v.doctor_name} on ${v.missed_slot}.\n` +
      `Would you like to reschedule? Next available: ${v.options}\n` +
      `Reply to this message or call ${v.hospital_contact} and our team will arrange a new time.`,
  },
  NOSHOW_FOLLOWUP_02: {
    providerName: "noshow_followup_02",
    category: "utility",
    params: ["patient_name", "hospital_name", "hospital_contact"],
    render: (v) =>
      `Hello ${v.patient_name}, this is a gentle follow-up from ${v.hospital_name} about your missed appointment. ` +
      `If you would still like to visit, call ${v.hospital_contact} and we will book a convenient time for you.`,
  },
  DISCHARGE_FOLLOWUP_01: {
    providerName: "discharge_followup_01",
    category: "utility",
    params: ["patient_name", "hospital_name", "followup_date", "hospital_contact"],
    render: (v) =>
      `Hello ${v.patient_name}, thank you for choosing ${v.hospital_name}. ` +
      `Your care team has scheduled a follow-up visit on ${v.followup_date}. ` +
      `To confirm or change the time, call ${v.hospital_contact}. ` +
      `Please continue to follow the instructions given to you at discharge.`,
  },
  FOLLOWUP_REMINDER_01: {
    providerName: "followup_reminder_01",
    category: "utility",
    params: ["patient_name", "hospital_name", "followup_date", "hospital_contact"],
    render: (v) =>
      `Reminder: ${v.patient_name}, your follow-up visit at ${v.hospital_name} is scheduled for ${v.followup_date}. ` +
      `To confirm a time or reschedule, call ${v.hospital_contact}.`,
  },
  FEEDBACK_REQUEST_01: {
    providerName: "feedback_request_01",
    category: "utility",
    params: ["patient_name", "hospital_name", "feedback_link"],
    render: (v) =>
      `Hello ${v.patient_name}, we hope you are recovering well. ` +
      `Could you rate your recent experience at ${v.hospital_name}? It takes less than a minute: ${v.feedback_link}`,
  },
  CONSULT_COMPLETE_01: {
    providerName: "consult_complete_01",
    category: "utility",
    params: ["patient_name", "hospital_name", "doctor_name", "next_step", "hospital_contact"],
    render: (v) =>
      `Hello ${v.patient_name}, your consultation with ${v.doctor_name} at ${v.hospital_name} is complete. ` +
      `${v.next_step} If you have any questions, call ${v.hospital_contact}.`,
  },
  APPT_REMINDER_01: {
    providerName: "appt_reminder_01",
    category: "utility",
    params: ["patient_name", "hospital_name", "doctor_name", "slot", "hospital_contact"],
    render: (v) =>
      `Reminder: ${v.patient_name}, you have an appointment at ${v.hospital_name} with ${v.doctor_name} on ${v.slot}. ` +
      `To reschedule, call ${v.hospital_contact}.`,
  },
} as const satisfies Record<string, TemplateDef>;

export type TemplateName = keyof typeof TEMPLATES;

export function isTemplateName(name: string): name is TemplateName {
  return Object.hasOwn(TEMPLATES, name);
}

export class TemplateError extends Error {}

/** Renders a template, failing loudly if any variable is missing or blank. */
export function renderTemplate(name: TemplateName, vars: Record<string, string>): { body: string; params: string[] } {
  const def: TemplateDef = TEMPLATES[name];
  const missing = def.params.filter((p) => !vars[p]?.trim());
  if (missing.length) throw new TemplateError(`Template ${name} missing variables: ${missing.join(", ")}`);
  return { body: def.render(vars), params: def.params.map((p) => vars[p]!) };
}
