import { buildLeadPrompt, MASTER_SYSTEM_PROMPT, PROMPT_LEAD_VERSION } from "./prompts";
import { checkSafety } from "./safety";
import {
  LlmLeadOutputSchema,
  NEEDS_HUMAN_REVIEW,
  type EnquiryType,
  type LeadClassification,
  type LeadClassificationInput,
  type LeadClassifier,
} from "./types";

export class AiProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AiProviderError";
  }
}

export interface OpenAiCompatibleConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}

/** Extracts a JSON object from model text, tolerating stray code fences. */
export function extractJson(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start === -1 || end <= start) throw new AiProviderError("Model output contained no JSON object");
  try {
    return JSON.parse(trimmed.slice(start, end + 1));
  } catch {
    throw new AiProviderError("Model output was not valid JSON");
  }
}

/**
 * Works with any OpenAI-compatible chat completions API:
 * OpenRouter, DeepSeek, OpenAI, Groq, Together, a local Ollama, etc.
 */
export class OpenAiCompatibleLeadClassifier implements LeadClassifier {
  readonly name = "openai_compatible";

  constructor(private readonly config: OpenAiCompatibleConfig) {}

  async classify(input: LeadClassificationInput): Promise<LeadClassification> {
    const content = await this.complete(buildLeadPrompt(input));
    const parsed = LlmLeadOutputSchema.safeParse(extractJson(content));
    if (!parsed.success) {
      throw new AiProviderError(`Model output failed schema validation: ${parsed.error.issues[0]?.message}`);
    }
    const out = parsed.data;

    // Never trust the model with the department list: it must be one we offered.
    const allowed = new Set(input.departments.map((d) => d.id));
    const department = allowed.has(out.department) ? out.department : NEEDS_HUMAN_REVIEW;

    // The deterministic safety net can only make the result more conservative, never less.
    const safety = checkSafety(input.enquiryText);
    const emergency = safety.emergency || out.enquiry_type === "emergency";
    let enquiryType: EnquiryType = out.enquiry_type;
    if (emergency) enquiryType = "emergency";
    else if (safety.clinicalQuestion) enquiryType = "clinical_question";

    const needsReview =
      out.priority_for_human_review === "review" ||
      emergency ||
      enquiryType === "clinical_question" ||
      safety.urgency ||
      department === NEEDS_HUMAN_REVIEW;

    return {
      department,
      enquiry_type: enquiryType,
      priority_for_human_review: needsReview ? "review" : "normal",
      missing_information: out.missing_information,
      reason: out.reason.slice(0, 500),
      emergency,
      safety_flags: safety.flags,
      provider: this.name,
      model: this.config.model,
      prompt_version: PROMPT_LEAD_VERSION,
    };
  }

  private async complete(userPrompt: string): Promise<string> {
    const doFetch = this.config.fetchImpl ?? fetch;
    const url = `${this.config.baseUrl.replace(/\/$/, "")}/chat/completions`;
    let res: Response;
    try {
      res = await doFetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.config.apiKey}`,
          // Optional OpenRouter attribution header; ignored by other providers.
          "x-title": "DemoCare Hospital Automation",
        },
        body: JSON.stringify({
          model: this.config.model,
          temperature: 0,
          // Generous enough that a model which thinks before answering still has room to answer.
          max_tokens: 800,
          response_format: { type: "json_object" },
          // Classification needs no chain of thought. Reasoning models otherwise spend the whole
          // budget thinking and return empty content; this also halves latency and cost.
          reasoning: { enabled: false },
          messages: [
            { role: "system", content: MASTER_SYSTEM_PROMPT },
            { role: "user", content: userPrompt },
          ],
        }),
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });
    } catch (err) {
      throw new AiProviderError(`AI request failed: ${(err as Error).message}`);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new AiProviderError(`AI provider returned HTTP ${res.status}: ${body.slice(0, 300)}`);
    }
    const data = (await res.json().catch(() => null)) as
      | { choices?: { finish_reason?: string; message?: { content?: string | null } }[] }
      | null;
    const choice = data?.choices?.[0];
    const content = choice?.message?.content;
    if (!content) {
      // A truncated answer is a configuration problem, so say which one.
      const truncated = choice?.finish_reason === "length";
      throw new AiProviderError(
        truncated
          ? `Model ${this.config.model} ran out of output tokens before answering (it may be a reasoning model)`
          : "AI provider returned an empty completion",
      );
    }
    return content;
  }
}
