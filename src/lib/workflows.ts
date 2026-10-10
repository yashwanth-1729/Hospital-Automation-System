/** Workflow registry. Names follow the blueprint naming convention (section F). */
export const WORKFLOWS = {
  access: { name: "HOSPITAL | 00 Staff Access", version: "1.0.0" },
  leadIntake: { name: "HOSPITAL | 01 Lead Intake", version: "1.0.0" },
  appointment: { name: "HOSPITAL | 02 Appointment", version: "1.0.0" },
  noShow: { name: "HOSPITAL | 03 No-Show Recovery", version: "1.0.0" },
  discharge: { name: "HOSPITAL | 04 Discharge Follow-Up", version: "1.0.0" },
  messaging: { name: "HOSPITAL | 90 Messaging", version: "1.0.0" },
  system: { name: "HOSPITAL | 99 System", version: "1.0.0" },
} as const;

export type WorkflowKey = keyof typeof WORKFLOWS;
