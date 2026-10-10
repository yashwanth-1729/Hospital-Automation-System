import { z } from "zod";
import { WORKFLOWS, type WorkflowKey } from "@/lib/workflows";
import { isTemplateName } from "@/server/messaging/templates";
import { sendTemplateMessage } from "@/server/messaging/send";
import { sendAppointmentConfirmation, sendAppointmentReminder } from "@/server/workflows/appointment";
import { JOB } from "@/server/workflows/job-types";
import { processLead } from "@/server/workflows/lead-intake";
import { escalateNoShow, recoverNoShow } from "@/server/workflows/no-show";
import { processDischarge, requestFeedback, sendDischargeReminder } from "@/server/workflows/discharge";
import { sendConsultFollowupReminder } from "@/server/clinic/consultation";
import { sendInvoiceDueReminder } from "@/server/billing/invoices";

/** Thrown for failures that will never succeed on retry (bad payload, unknown job type). */
export class PermanentJobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermanentJobError";
  }
}

function parse<T extends z.ZodType>(schema: T, payload: unknown): z.infer<T> {
  const r = schema.safeParse(payload);
  if (!r.success) throw new PermanentJobError(`Invalid job payload: ${r.error.issues[0]?.message}`);
  return r.data;
}

const workflowKey = z.string().refine((k): k is WorkflowKey => Object.hasOwn(WORKFLOWS, k), "unknown workflow");

export interface JobContext {
  correlationId: string | null;
}

const handlers: Record<string, (payload: unknown, ctx: JobContext) => Promise<void>> = {
  [JOB.leadProcess]: async (payload) => {
    const { lead_id } = parse(z.object({ lead_id: z.string() }), payload);
    await processLead(lead_id);
  },
  [JOB.appointmentConfirm]: async (payload) => {
    const { appointment_id } = parse(z.object({ appointment_id: z.string() }), payload);
    await sendAppointmentConfirmation(appointment_id);
  },
  [JOB.appointmentReminder]: async (payload) => {
    const p = parse(z.object({ appointment_id: z.string(), stage: z.enum(["24h", "3h"]), slot_start: z.string() }), payload);
    await sendAppointmentReminder(p.appointment_id, p.stage, p.slot_start);
  },
  [JOB.noShowRecover]: async (payload) => {
    const { appointment_id } = parse(z.object({ appointment_id: z.string() }), payload);
    await recoverNoShow(appointment_id);
  },
  [JOB.noShowEscalate]: async (payload) => {
    const p = parse(z.object({ appointment_id: z.string(), attempt: z.number().int().min(1) }), payload);
    await escalateNoShow(p.appointment_id, p.attempt);
  },
  [JOB.dischargeProcess]: async (payload) => {
    const { discharge_id } = parse(z.object({ discharge_id: z.string() }), payload);
    await processDischarge(discharge_id);
  },
  [JOB.dischargeReminder]: async (payload) => {
    const p = parse(z.object({ discharge_id: z.string(), followup_date: z.string() }), payload);
    await sendDischargeReminder(p.discharge_id, p.followup_date);
  },
  [JOB.consultFollowupReminder]: async (payload) => {
    const p = parse(z.object({ consultation_id: z.string(), followup_date: z.string() }), payload);
    await sendConsultFollowupReminder(p.consultation_id, p.followup_date);
  },
  [JOB.invoiceDue]: async (payload) => {
    const { invoice_id } = parse(z.object({ invoice_id: z.string() }), payload);
    await sendInvoiceDueReminder(invoice_id);
  },
  [JOB.feedbackRequest]: async (payload) => {
    const { discharge_id } = parse(z.object({ discharge_id: z.string() }), payload);
    await requestFeedback(discharge_id);
  },
  [JOB.messageSend]: async (payload, ctx) => {
    const p = parse(
      z.object({
        dedupe_key: z.string(),
        patient_id: z.string(),
        template: z.string().refine(isTemplateName, "unknown template"),
        workflow: workflowKey,
        lead_id: z.string().nullish(),
        vars: z.record(z.string(), z.string()),
      }),
      payload,
    );
    await sendTemplateMessage({
      dedupeKey: p.dedupe_key,
      patientId: p.patient_id,
      template: p.template as Parameters<typeof sendTemplateMessage>[0]["template"],
      workflow: p.workflow as WorkflowKey,
      leadId: p.lead_id ?? null,
      correlationId: ctx.correlationId,
      vars: p.vars,
    });
  },
};

export function getHandler(type: string) {
  const h = handlers[type];
  if (!h) throw new PermanentJobError(`No handler for job type ${type}`);
  return h;
}
