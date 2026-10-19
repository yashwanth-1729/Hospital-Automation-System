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
  // Only needed by scripts/register-templates.ts, to submit templates for approval.
  WA_BUSINESS_ACCOUNT_ID: optionalString,
  // Comma-separated mobile numbers. When set, real WhatsApp is sent to these numbers only: a
  // safety net for test numbers and demos, where Meta would reject everyone else anyway.
  WA_ALLOWED_RECIPIENTS: optionalString,
  /** Demo servers only: one-click sign-in buttons for the *@democare.test role accounts. Never administrators. */
  DEMO_QUICK_LOGIN: z.string().optional(),
  WA_API_VERSION: z.string().default("v23.0"),
  WA_TEMPLATE_LANGUAGE: z.string().default("en"),

  // --- No-show recovery ---
  NO_SHOW_AUTO_DETECT: z.stringbool().default(true),
  NO_SHOW_GRACE_MINUTES: z.coerce.number().int().min(0).default(60),
  NO_SHOW_RECOVERY_DELAY_MINUTES: z.coerce.number().int().min(0).default(30),
  NO_SHOW_FOLLOWUP_HOURS: z.coerce.number().int().min(1).default(24),
  NO_SHOW_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(5).default(2),

  // --- Discharge follow-up & feedback ---
  FEEDBACK_DELAY_HOURS: z.coerce.number().int().min(0).default(48),
  FEEDBACK_LINK_VALID_DAYS: z.coerce.number().int().min(1).default(30),
  // IST hour at which the day-before follow-up reminder is sent.
  FOLLOWUP_REMINDER_HOUR: z.coerce.number().int().min(0).max(23).default(10),
  // Base URL used in patient links (feedback form).
  PUBLIC_BASE_URL: z.string().url().default("http://localhost:3000"),

  // Inbound WhatsApp: Meta signs each webhook with the app secret, and checks the verify
  // token once when the webhook is first registered.
  WA_APP_SECRET: optionalString,
  WA_VERIFY_TOKEN: optionalString,

  // --- Retention (DPDP Act 2023) ---
  RETENTION_ENABLED: z.stringbool().default(true),
  // Message bodies are redacted after this long; the log of what was sent, when, remains.
  RETENTION_MESSAGE_DAYS: z.coerce.number().int().min(7).default(180),
  // Free-text enquiries are cleared after this long; the structured lead record remains.
  RETENTION_ENQUIRY_DAYS: z.coerce.number().int().min(7).default(365),

  WEBHOOK_SECRET: optionalString,
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
  if (e.MESSAGING_PROVIDER === "whatsapp_cloud") {
    if (!e.WA_PHONE_NUMBER_ID || !e.WA_ACCESS_TOKEN) {
      throw new Error("MESSAGING_PROVIDER=whatsapp_cloud requires WA_PHONE_NUMBER_ID and WA_ACCESS_TOKEN");
    }
    // Without the app secret an inbound webhook cannot be trusted, and anyone who learns the
    // URL could mark messages delivered or opt a patient out.
    if (!e.WA_APP_SECRET) {
      throw new Error("MESSAGING_PROVIDER=whatsapp_cloud requires WA_APP_SECRET to verify inbound webhooks");
    }
  }
  cached = e;
  return e;
}

/** Tests override settings between cases. */
export function resetEnvCache() {
  cached = undefined;
}
