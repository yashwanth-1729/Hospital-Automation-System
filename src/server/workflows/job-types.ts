export const JOB = {
  leadProcess: "lead.process",
  appointmentConfirm: "appointment.confirm",
  appointmentReminder: "appointment.reminder",
  messageSend: "message.send",
  noShowRecover: "noshow.recover",
  noShowEscalate: "noshow.escalate",
} as const;

export type JobType = (typeof JOB)[keyof typeof JOB];
