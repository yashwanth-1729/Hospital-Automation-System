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
