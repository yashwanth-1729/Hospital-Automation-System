import { env } from "@/lib/env";
import { AiProviderError, OpenAiCompatibleLeadClassifier } from "./llm";
import { RulesLeadClassifier } from "./rules";
import type { LeadClassification, LeadClassificationInput, LeadClassifier } from "./types";

export * from "./types";

let override: LeadClassifier | undefined;

/** Tests inject a fake classifier. */
export function setLeadClassifierForTests(c: LeadClassifier | undefined) {
  override = c;
}

export function getLeadClassifier(): LeadClassifier {
  if (override) return override;
  const e = env();
  if (e.AI_PROVIDER === "openai_compatible") {
    return new OpenAiCompatibleLeadClassifier({
      baseUrl: e.AI_BASE_URL,
      apiKey: e.AI_API_KEY!,
      model: e.AI_MODEL,
      timeoutMs: e.AI_TIMEOUT_MS,
    });
  }
  return new RulesLeadClassifier();
}

export interface ClassificationOutcome {
  result: LeadClassification;
  /** Set when the configured AI failed and the rules classifier was used instead. */
  fallbackReason: string | null;
}

/**
 * Classifies with the configured provider. If the AI is down or returns garbage,
 * falls back to the deterministic rules classifier so leads never stall.
 */
export async function classifyLead(input: LeadClassificationInput): Promise<ClassificationOutcome> {
  const primary = getLeadClassifier();
  try {
    return { result: await primary.classify(input), fallbackReason: null };
  } catch (err) {
    if (primary.name === "rules" || !(err instanceof AiProviderError)) throw err;
    const result = await new RulesLeadClassifier().classify(input);
    return { result: { ...result, provider: "rules_fallback" }, fallbackReason: err.message };
  }
}
