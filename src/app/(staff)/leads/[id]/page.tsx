import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { AutoRefresh } from "@/components/client";
import { Badge, Card, Empty, LeadStatus, MessageStatus, Mono, PageHeader } from "@/components/ui";
import { formatDateTime, formatSlot } from "@/lib/time";
import { resolveDepartment } from "@/server/ai/rules";
import { getLead, getTimeline, listDepartments, listMessages } from "@/server/queries";
import { listOpenSlots } from "@/server/workflows/scheduling";
import { BookLead, type DepartmentSlots } from "./book";

export const metadata = { title: "Lead" };

const ACTION_LABELS: Record<string, string> = {
  "lead.received": "Enquiry received",
  "lead.classified": "Classified",
  "lead.routed_to_human": "Routed to staff",
  "appointment.booked": "Appointment booked",
  "appointment.no_slot": "No slot available",
  "message.sent": "WhatsApp sent",
  "message.skipped_no_consent": "Message skipped (no consent)",
  "message.delivery_unknown": "Delivery unknown",
  "reminder.skipped": "Reminder skipped",
  "job.dead": "Automation step failed",
  "appointment.booked_by_staff": "Booked by staff",
  "appointment.cancelled": "Appointment cancelled",
  "appointment.rescheduled": "Appointment rescheduled",
  "attendance.marked": "Attendance recorded",
  "noshow.recovery_started": "No-show recovery started",
  "noshow.recovered": "Patient rebooked",
  "noshow.escalated_to_staff": "Escalated to reception",
  "exception.resolved": "Exception resolved",
};

const ACTOR_TONE = { ai: "primary", patient: "info", staff: "warn", system: "neutral", integration: "neutral" } as const;

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="mt-0.5 text-sm">{children}</dd>
    </div>
  );
}

function eventSummary(action: string, d: Record<string, unknown> | null): string | null {
  if (!d) return null;
  if (action === "lead.classified") {
    const parts = [`→ ${d.department}`, String(d.enquiry_type), `via ${d.provider}${d.model ? ` (${d.model})` : ""}`];
    return parts.join(" · ");
  }
  if (action === "message.sent") return String(d.template);
  if (action === "lead.routed_to_human") return String(d.reason);
  if (action === "appointment.booked") return `${d.doctor_id}`;
  if (action === "reminder.skipped") return `${d.stage}: ${d.reason}`;
  return null;
}

export default async function LeadDetailPage({ params }: { params: Promise<{ id: string }> }) {
  await connection();
  const { id } = await params;
  const lead = await getLead(id);
  if (!lead) notFound();
  const [timeline, messages] = await Promise.all([getTimeline(lead.correlation_id), listMessages({ correlationId: lead.correlation_id })]);
  const ai = lead.ai_result as { reason?: string; safety_flags?: string[]; provider?: string } | null;

  // Staff booking is offered only while the lead is still waiting on a person.
  const needsBooking = lead.status === "needs_review" || lead.status === "no_slot";
  let departmentSlots: DepartmentSlots[] = [];
  let preselected: string | null = null;
  if (needsBooking) {
    const departments = await listDepartments();
    departmentSlots = await Promise.all(
      departments.map(async (d) => ({
        departmentId: d.department_id,
        name: d.name,
        slots: (await listOpenSlots(d.department_id, 15)).map((s) => ({
          slot_id: s.slot_id,
          label: `${formatSlot(s.slot_start)} · ${s.doctor_name}`,
        })),
      })),
    );
    preselected = resolveDepartment(
      lead.department ?? lead.department_requested,
      departments.map((d) => ({ id: d.department_id, name: d.name })),
    );
  }

  return (
    <>
      <AutoRefresh seconds={4} />
      <div className="mb-2 text-sm">
        <Link href="/leads" className="text-muted hover:text-text">← Leads</Link>
      </div>
      <PageHeader title={lead.full_name} description={lead.correlation_id} actions={<LeadStatus status={lead.status} />} />

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-1">
          <Card title="Enquiry">
            <dl className="grid gap-3 p-4">
              <Field label="Message">
                <p className="rounded-lg bg-surface-2 p-3 whitespace-pre-wrap">{lead.enquiry_text}</p>
              </Field>
              <Field label="Phone"><span className="num">{lead.phone}</span></Field>
              <Field label="Source">{lead.source}</Field>
              <Field label="Requested">{lead.department_requested ?? "—"} · {lead.preferred_date ?? "no date"}</Field>
              <Field label="Patient">{lead.patient_status ?? "—"} · consent {lead.consent_status}</Field>
            </dl>
          </Card>

          {needsBooking && (
            <Card title="Book this patient">
              <BookLead leadId={lead.lead_id} departments={departmentSlots} preselected={preselected} />
            </Card>
          )}

          <Card title="Outcome">
            <dl className="grid gap-3 p-4">
              <Field label="Department">{lead.department ?? "Needs a person to decide"}</Field>
              <Field label="Enquiry type">{lead.enquiry_type ?? "—"}</Field>
              {lead.slot_start && (
                <Field label="Appointment">
                  {formatSlot(lead.slot_start)}
                  <div className="text-xs text-muted">{lead.doctor_name} · {lead.appointment_id}</div>
                </Field>
              )}
              {ai?.reason && <Field label="Classifier reasoning">{ai.reason}</Field>}
              {!!ai?.safety_flags?.length && (
                <Field label="Safety flags">
                  <div className="flex flex-wrap gap-1">
                    {ai.safety_flags.map((f) => <Badge key={f} tone="danger">{f}</Badge>)}
                  </div>
                </Field>
              )}
            </dl>
          </Card>
        </div>

        <Card title="Automation timeline" className="lg:col-span-2">
          {timeline.length === 0 ? (
            <Empty>No events yet.</Empty>
          ) : (
            <ol className="relative px-4 py-4">
              {timeline.map((ev, i) => (
                <li key={ev.event_id} className="relative flex gap-4 pb-5 last:pb-0">
                  {i < timeline.length - 1 && <span className="absolute top-3 left-[5px] h-full w-px bg-border" aria-hidden />}
                  <span className="relative mt-1.5 h-[11px] w-[11px] shrink-0 rounded-full border-2 border-primary bg-surface" />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium">{ACTION_LABELS[ev.action] ?? ev.action}</span>
                      <Badge tone={ACTOR_TONE[ev.actor_type as keyof typeof ACTOR_TONE] ?? "neutral"}>{ev.actor_type}</Badge>
                      <span className="num ml-auto text-xs text-muted">{formatDateTime(ev.timestamp)}</span>
                    </div>
                    {eventSummary(ev.action, ev.details) && <div className="mt-0.5 text-sm text-muted">{eventSummary(ev.action, ev.details)}</div>}
                    <Mono>{ev.workflow_name}</Mono>
                  </div>
                </li>
              ))}
            </ol>
          )}
          {messages.length > 0 && (
            <div className="border-t border-border p-4">
              <h3 className="mb-3 text-xs font-medium tracking-wide text-muted uppercase">Messages to patient</h3>
              <ul className="space-y-3">
                {messages.map((m) => (
                  <li key={m.message_id} className="rounded-lg border border-border p-3">
                    <div className="mb-1 flex items-center gap-2">
                      <Mono>{m.template_name}</Mono>
                      <MessageStatus status={m.delivery_status} />
                      {m.skip_reason && <span className="text-xs text-muted">{m.skip_reason}</span>}
                    </div>
                    <p className="text-sm whitespace-pre-wrap">{m.body}</p>
                    {m.error && <p className="mt-1 text-xs text-danger">{m.error}</p>}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Card>
      </div>
    </>
  );
}
