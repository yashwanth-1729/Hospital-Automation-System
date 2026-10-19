/**
 * Who may do what. Pure data and pure functions, so it can be tested without a database and
 * imported from anywhere (proxy, server components, scripts).
 *
 * Roles map to capabilities, and every page and action asks for a capability, never a role.
 * Adding a module means adding capabilities here and granting them; no call site changes.
 */

export const ROLES = ["admin", "receptionist", "doctor", "pharmacist", "billing", "nurse", "radiology"] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABEL: Record<Role, string> = {
  admin: "Administrator",
  receptionist: "Receptionist",
  doctor: "Doctor",
  pharmacist: "Pharmacist",
  billing: "Billing",
  nurse: "Nurse",
  radiology: "Radiology",
};

export const CAPABILITIES = [
  // Patient communication console (the original product)
  "dashboard.view",
  "leads.manage",
  "appointments.view",
  "appointments.manage",
  "discharges.manage",
  "followups.manage",
  "feedback.view",
  "exceptions.manage",
  "reports.view",
  "audits.manage",
  "demo.phone",
  // Front desk
  "patients.view",
  "patients.register",
  "queue.view",
  "queue.manage",
  // Clinical
  "records.view",
  "vitals.record",
  "consult.write",
  // Pharmacy
  "pharmacy.dispense",
  "pharmacy.stock",
  // Billing
  "billing.view",
  "billing.collect",
  "billing.manage",
  "billing.discount_large",
  // Inpatient
  "ipd.view",
  "ipd.admit",
  "ipd.transfer",
  "ipd.discharge",
  "ipd.beds",
  "ipd.configure",
  // Radiology
  "imaging.order",
  "imaging.view",
  "imaging.report",
  // Assistant
  "assistant.use",
  // Administration
  "users.manage",
] as const;
export type Capability = (typeof CAPABILITIES)[number];

const GRANTS: Record<Role, readonly Capability[]> = {
  admin: CAPABILITIES,
  receptionist: [
    "dashboard.view",
    "leads.manage",
    "appointments.view",
    "appointments.manage",
    "discharges.manage",
    "followups.manage",
    "feedback.view",
    "exceptions.manage",
    "patients.view",
    "patients.register",
    "queue.view",
    "queue.manage",
    "billing.view",
    "billing.collect",
    "ipd.view",
    "ipd.admit",
    "ipd.transfer",
    "ipd.discharge",
  ],
  doctor: [
    "dashboard.view", "appointments.view", "patients.view", "queue.view", "records.view", "vitals.record", "consult.write",
    "ipd.view", "ipd.discharge", "imaging.order", "imaging.view",
  ],
  nurse: [
    "dashboard.view", "appointments.view", "discharges.manage", "patients.view", "queue.view", "records.view", "vitals.record",
    "ipd.view", "ipd.admit", "ipd.transfer", "ipd.discharge", "ipd.beds", "imaging.view",
  ],
  pharmacist: ["dashboard.view", "patients.view", "pharmacy.dispense", "pharmacy.stock"],
  billing: ["dashboard.view", "patients.view", "billing.view", "billing.collect", "billing.manage", "ipd.view"],
  radiology: ["dashboard.view", "patients.view", "imaging.view", "imaging.report"],
};

export function can(role: Role, capability: Capability): boolean {
  return GRANTS[role].includes(capability);
}

/** Extra capabilities are added by later modules through this, keeping their grants beside them. */
export function grantsFor(role: Role): readonly Capability[] {
  return GRANTS[role];
}

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}
