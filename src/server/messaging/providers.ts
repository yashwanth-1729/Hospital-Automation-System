import { env } from "@/lib/env";
import { newId } from "@/lib/ids";
import { TEMPLATES, type TemplateName } from "./templates";

export interface OutboundMessage {
  to: string; // E.164
  template: TemplateName;
  params: string[];
  body: string;
}

/**
 * definite: the provider answered and the message was NOT accepted -> safe to retry.
 * ambiguous: we cannot know whether it was sent (timeout, dropped connection) -> never auto-retry.
 */
export class MessagingError extends Error {
  constructor(
    message: string,
    readonly kind: "definite" | "ambiguous",
    readonly permanent: boolean,
  ) {
    super(message);
    this.name = "MessagingError";
  }
}

export interface MessageProvider {
  readonly name: string;
  readonly channel: string;
  send(msg: OutboundMessage): Promise<{ providerMessageId: string }>;
}

/**
 * Demo provider: messages are only stored and shown on the dashboard's Demo Phone.
 * Numbers ending in 0000 simulate a permanent provider rejection so the failure path can be demoed.
 */
export class MockMessageProvider implements MessageProvider {
  readonly name = "mock";
  readonly channel = "whatsapp";

  async send(msg: OutboundMessage) {
    if (msg.to.endsWith("0000")) {
      throw new MessagingError("Mock provider: recipient is not a WhatsApp user (simulated)", "definite", true);
    }
    return { providerMessageId: newId("MOCKWA") };
  }
}

/** Meta WhatsApp Cloud API: https://developers.facebook.com/docs/whatsapp/cloud-api */
export class WhatsAppCloudProvider implements MessageProvider {
  readonly name = "whatsapp_cloud";
  readonly channel = "whatsapp";

  constructor(
    private readonly cfg: {
      phoneNumberId: string;
      accessToken: string;
      apiVersion: string;
      language: string;
      timeoutMs?: number;
      fetchImpl?: typeof fetch;
    },
  ) {}

  async send(msg: OutboundMessage) {
    const doFetch = this.cfg.fetchImpl ?? fetch;
    const url = `https://graph.facebook.com/${this.cfg.apiVersion}/${this.cfg.phoneNumberId}/messages`;
    let res: Response;
    try {
      res = await doFetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.cfg.accessToken}` },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to: msg.to.replace(/^\+/, ""),
          type: "template",
          template: {
            name: TEMPLATES[msg.template].providerName,
            language: { code: this.cfg.language },
            components: [{ type: "body", parameters: msg.params.map((text) => ({ type: "text", text })) }],
          },
        }),
        signal: AbortSignal.timeout(this.cfg.timeoutMs ?? 15000),
      });
    } catch (err) {
      // The request may or may not have reached Meta. Treat as unknown outcome.
      throw new MessagingError(`WhatsApp request outcome unknown: ${(err as Error).message}`, "ambiguous", false);
    }
    const data = (await res.json().catch(() => null)) as
      | { messages?: { id: string }[]; error?: { message?: string; code?: number } }
      | null;
    if (!res.ok) {
      const detail = data?.error?.message ?? `HTTP ${res.status}`;
      const retryable = res.status === 429 || res.status >= 500;
      throw new MessagingError(`WhatsApp rejected message: ${detail}`, "definite", !retryable);
    }
    const id = data?.messages?.[0]?.id;
    if (!id) throw new MessagingError("WhatsApp response had no message id", "ambiguous", false);
    return { providerMessageId: id };
  }
}

let override: MessageProvider | undefined;

export function setMessageProviderForTests(p: MessageProvider | undefined) {
  override = p;
}

export function getMessageProvider(): MessageProvider {
  if (override) return override;
  const e = env();
  if (e.MESSAGING_PROVIDER === "whatsapp_cloud") {
    return new WhatsAppCloudProvider({
      phoneNumberId: e.WA_PHONE_NUMBER_ID!,
      accessToken: e.WA_ACCESS_TOKEN!,
      apiVersion: e.WA_API_VERSION,
      language: e.WA_TEMPLATE_LANGUAGE,
    });
  }
  return new MockMessageProvider();
}
