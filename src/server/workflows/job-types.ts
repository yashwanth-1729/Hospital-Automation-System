export const JOB = {
  leadProcess: "lead.process",
  appointmentConfirm: "appointment.confirm",
  appointmentReminder: "appointment.reminder",
  messageSend: "message.send",
  noShowRecover: "noshow.recover",
  noShowEscalate: "noshow.escalate",
  dischargeProcess: "discharge.process",
  dischargeReminder: "discharge.reminder",
  feedbackRequest: "feedback.request",
} as const;

export type JobType = (typeof JOB)[keyof typeof JOB];
