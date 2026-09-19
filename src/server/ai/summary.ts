import { z } from "zod";
import { pool } from "@/lib/db";
import { env } from "@/lib/env";
import { istDateString } from "@/lib/time";
import { AiProviderError, extractJson } from "./llm";
import { MASTER_SYSTEM_PROMPT } from "./prompts";

export const PROMPT_SUMMARY_VERSION = "PROMPT_SUMMARY_01";

export const SummarySchema = z.object({
  headline: z.string().max(300),
  wins: z.array(z.string().max(300)).max(5).default([]),
  exceptions: z.array(z.string().max(300)).max(5).default([]),
  overdue_items: z.array(z.string().max(300)).max(5).default([]),
  questions_for_management: z.array(z.string().max(300)).max(5).default([]),
});
export type ManagementSummary = z.infer<typeof SummarySchema>;

export interface SummaryResult {
  summary: ManagementSummary;
  provider: string;
  model: string | null;
  generatedAt: Date;
  cached: boolean;
}

function buildPrompt(metrics: unknown): string {
  return `TASK
Summarize only the supplied operational metrics for hospital management.

INPUT
${JSON.stringify(metrics, null, 2)}

RETURN JSON
{
  "headline": "<one sentence on how the period went operationally>",
  "wins": [],
  "exceptions": [],
  "overdue_items": [],
  "questions_for_management": []
}

RULES
- Use only the numbers supplied. Never invent a metric or a cause.
- No clinical conclusions and no medical language.
- Keep each item to one short sentence an administrator can act on.`;
}

/** Deterministic summary, used when no AI provider is configured or the provider fails. */
export function ruleBasedSummary(m: ReturnType<typeof import("@/server/reports").summaryMetrics>): ManagementSummary {
  const wins: string[] = [];
  const exceptions: string[] = [];
  const overdue: string[] = [];
  const questions: string[] = [];

  const booked = m.booked_automatically + m.booked_by_staff;
  if (m.median_first_response_seconds !== null && m.median_first_response_seconds < 300) {
    wins.push(`Median first response was ${m.median_first_response_seconds} seconds.`);
  }
  if (booked > 0) wins.push(`${booked} appointments booked from ${m.enquiries} enquiries (${m.conversion_rate_percent ?? 0}%).`);
  if (m.booked_automatically > 0) wins.push(`${m.booked_automatically} of those were booked without staff involvement.`);

  if (m.needing_human_review > 0) exceptions.push(`${m.needing_human_review} enquiries needed a person to decide.`);
  if (m.no_slot_available > 0) exceptions.push(`${m.no_slot_available} enquiries found no slot on the requested date.`);
  if (m.messages_failed > 0) exceptions.push(`${m.messages_failed} patient messages failed to send.`);
  if (m.no_shows > 0) exceptions.push(`${m.no_shows} patients did not attend.`);
  if (m.open_exceptions > 0) overdue.push(`${m.open_exceptions} items are open in the exception queue.`);

  if (m.no_slot_available > 0) questions.push("Should more slots be opened in the departments that ran out?");
  if (m.no_shows > 0) questions.push("Should the reminder timing be reviewed for departments with the most no-shows?");

  return {
    headline: `${m.enquiries} enquiries, ${booked} booked, ${m.no_shows} no-shows over the last ${m.period_days} day(s).`,
    wins,
    exceptions,
    overdue_items: overdue,
    questions_for_management: questions,
  };
}

async function llmSummary(metrics: unknown, fetchImpl?: typeof fetch): Promise<{ summary: ManagementSummary; model: string }> {
  const e = env();
  const doFetch = fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await doFetch(`${e.AI_BASE_URL.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${e.AI_API_KEY}`, "x-title": "NIT Hospital Automation" },
      body: JSON.stringify({
        model: e.AI_MODEL,
        temperature: 0,
        max_tokens: 700,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: MASTER_SYSTEM_PROMPT },
          { role: "user", content: buildPrompt(metrics) },
        ],
      }),
      signal: AbortSignal.timeout(e.AI_TIMEOUT_MS),
    });
  } catch (err) {
    throw new AiProviderError(`Summary request failed: ${(err as Error).message}`);
  }
  if (!res.ok) throw new AiProviderError(`AI provider returned HTTP ${res.status}`);
  const data = (await res.json().catch(() => null)) as { choices?: { message?: { content?: string } }[] } | null;
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new AiProviderError("AI provider returned an empty completion");

  const parsed = SummarySchema.safeParse(extractJson(content));
  if (!parsed.success) throw new AiProviderError(`Summary failed schema validation: ${parsed.error.issues[0]?.message}`);
  return { summary: parsed.data, model: e.AI_MODEL };
}

/**
 * Management summary for one IST day. Only aggregate numbers leave this process:
 * no names, phone numbers, enquiry text or clinical data are ever sent to the AI provider.
 */
export async function generateDailySummary(
  metrics: ReturnType<typeof import("@/server/reports").summaryMetrics>,
  opts: { date?: string; force?: boolean; fetchImpl?: typeof fetch } = {},
): Promise<SummaryResult> {
  const date = opts.date ?? istDateString();
  const db = pool();

  if (!opts.force) {
    const cached = await db.query<{ summary: ManagementSummary; provider: string; model: string | null; generated_at: Date }>(
      `SELECT summary, provider, model, generated_at FROM daily_summaries WHERE summary_date = $1`,
      [date],
    );
    const row = cached.rows[0];
    if (row) return { summary: row.summary, provider: row.provider, model: row.model, generatedAt: row.generated_at, cached: true };
  }

  const e = env();
  let summary: ManagementSummary;
  let provider = "rules";
  let model: string | null = null;

  if (e.AI_PROVIDER === "openai_compatible") {
    try {
      const r = await llmSummary(metrics, opts.fetchImpl);
      summary = r.summary;
      provider = "openai_compatible";
      model = r.model;
    } catch {
      summary = ruleBasedSummary(metrics);
      provider = "rules_fallback";
    }
  } else {
    summary = ruleBasedSummary(metrics);
  }

  const saved = await db.query<{ generated_at: Date }>(
    `INSERT INTO daily_summaries (summary_date, metrics, summary, provider, model)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (summary_date) DO UPDATE SET metrics = EXCLUDED.metrics, summary = EXCLUDED.summary,
       provider = EXCLUDED.provider, model = EXCLUDED.model, generated_at = now()
     RETURNING generated_at`,
    [date, metrics, summary, provider, model],
  );
  return { summary, provider, model, generatedAt: saved.rows[0]!.generated_at, cached: false };
}
