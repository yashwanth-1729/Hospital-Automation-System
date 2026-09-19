import { z } from "zod";

const emptyToUndefined = (v: unknown) => (v === "" ? undefined : v);
const optionalString = z.preprocess(emptyToUndefined, z.string().optional());

const EnvSchema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  HOSPITAL_NAME: z.string().default("DemoCare Multispeciality Hospital"),
  HOSPITAL_CONTACT: z.string().default("+91 80000 00000"),
  EMERGENCY_NUMBER: z.string().default("108"),

  AI_PROVIDER: z.enum(["rules", "openai_compatible"]).default("rules"),
  AI_BASE_URL: z.string().url().default("https://openrouter.ai/api/v1"),
  AI_API_KEY: optionalString,
  AI_MODEL: z.string().default("anthropic/claude-haiku-4.5"),
  AI_TIMEOUT_MS: z.coerce.number().int().positive().default(20000),

  MESSAGING_PROVIDER: z.enum(["mock", "whatsapp_cloud"]).default("mock"),
  WA_PHONE_NUMBER_ID: optionalString,
  WA_ACCESS_TOKEN: optionalString,
  WA_API_VERSION: z.string().default("v23.0"),
  WA_TEMPLATE_LANGUAGE: z.string().default("en"),

  WEBHOOK_SECRET: optionalString,
  DASHBOARD_PASSWORD: optionalString,
});

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | undefined;

/** Parsed, validated environment. Throws with a readable message on bad config. */
export function env(): Env {
  if (cached) return cached;
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  const e = parsed.data;
  if (e.AI_PROVIDER === "openai_compatible" && !e.AI_API_KEY) {
    throw new Error("AI_PROVIDER=openai_compatible requires AI_API_KEY");
  }
  if (e.MESSAGING_PROVIDER === "whatsapp_cloud" && (!e.WA_PHONE_NUMBER_ID || !e.WA_ACCESS_TOKEN)) {
    throw new Error("MESSAGING_PROVIDER=whatsapp_cloud requires WA_PHONE_NUMBER_ID and WA_ACCESS_TOKEN");
  }
  cached = e;
  return e;
}

/** Tests override settings between cases. */
export function resetEnvCache() {
  cached = undefined;
}
