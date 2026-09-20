import { describe, expect, it, vi } from "vitest";
import { classifyLead, setLeadClassifierForTests } from "@/server/ai";
import { extractJson, OpenAiCompatibleLeadClassifier } from "@/server/ai/llm";
import { RulesLeadClassifier } from "@/server/ai/rules";
import { checkSafety } from "@/server/ai/safety";
import { NEEDS_HUMAN_REVIEW, type LeadClassificationInput } from "@/server/ai/types";
import { DEMO_DEPARTMENTS } from "../scripts/seed";

const departments = DEMO_DEPARTMENTS.map((d) => ({ id: d.id, name: d.name }));
const input = (enquiryText: string, departmentSelected: string | null = null): LeadClassificationInput => ({
  enquiryText,
  departmentSelected,
  source: "website",
  departments,
});

describe("safety net", () => {
  it.each([
    "I have severe chest pain since morning",
    "my father can't breathe properly",
    "Mummy behosh ho gayi",
    "heavy bleeding after fall",
    "I want to end my life",
    "child swallowed a tablet",
    "seene me dard ho raha hai",
  ])("flags emergency: %s", (text) => {
    expect(checkSafety(text).emergency).toBe(true);
  });

  it.each([
    "which medicine should I take for acne",
    "is my report normal?",
    "is it cancer?",
    "what treatment is best for knee pain",
  ])("flags clinical question: %s", (text) => {
    const s = checkSafety(text);
    expect(s.clinicalQuestion).toBe(true);
    expect(s.emergency).toBe(false);
  });

  it("does not flag routine booking requests", () => {
    const s = checkSafety("I want to book a skin consultation for acne next week");
    expect(s).toMatchObject({ emergency: false, clinicalQuestion: false, urgency: false });
  });

  it("treats urgency as review-worthy but not an emergency", () => {
    const s = checkSafety("need an urgent appointment for rash");
    expect(s.emergency).toBe(false);
    expect(s.urgency).toBe(true);
  });
});

describe("rules classifier", () => {
  const c = new RulesLeadClassifier();

  it("uses the selected department when consistent", async () => {
    const r = await c.classify(input("I want to book a consultation.", "Dermatology"));
    expect(r).toMatchObject({ department: "dermatology", enquiry_type: "appointment_booking", priority_for_human_review: "normal" });
  });

  it("infers department from keywords", async () => {
    const r = await c.classify(input("Need appointment for knee pain"));
    expect(r.department).toBe("orthopedics");
    expect(r.priority_for_human_review).toBe("normal");
  });

  it("sends conflicting selection to review", async () => {
    const r = await c.classify(input("appointment for my knee fracture", "Dermatology"));
    expect(r.department).toBe(NEEDS_HUMAN_REVIEW);
    expect(r.priority_for_human_review).toBe("review");
  });

  it("sends unidentifiable enquiries to review with missing info", async () => {
    const r = await c.classify(input("hello, what are your timings?"));
    expect(r.department).toBe(NEEDS_HUMAN_REVIEW);
    expect(r.missing_information).toContain("department");
  });

  it("marks emergencies and clinical questions for review", async () => {
    const e = await c.classify(input("chest pain and sweating", "Cardiology"));
    expect(e).toMatchObject({ emergency: true, enquiry_type: "emergency", priority_for_human_review: "review" });
    const q = await c.classify(input("which medicine should I take for acne", "Dermatology"));
    expect(q).toMatchObject({ enquiry_type: "clinical_question", priority_for_human_review: "review" });
  });

  it("rejects unknown department names", async () => {
    const r = await c.classify(input("book appointment", "Neurosurgery"));
    expect(r.department).toBe(NEEDS_HUMAN_REVIEW);
  });
});

function fakeFetch(content: string | null, status = 200) {
  return vi.fn(async () =>
    new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status, headers: { "content-type": "application/json" } }),
  ) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}

const llm = (f: typeof fetch) =>
  new OpenAiCompatibleLeadClassifier({ baseUrl: "https://llm.test/v1", apiKey: "k", model: "test-model", timeoutMs: 1000, fetchImpl: f });

const good = JSON.stringify({
  department: "dermatology",
  enquiry_type: "appointment_booking",
  priority_for_human_review: "normal",
  missing_information: [],
  reason: "Skin consultation requested.",
});

describe("OpenAI-compatible classifier", () => {
  it("parses a valid response", async () => {
    const r = await llm(fakeFetch(good)).classify(input("book for acne", "Dermatology"));
    expect(r).toMatchObject({ department: "dermatology", priority_for_human_review: "normal", model: "test-model" });
  });

  it("never sends patient identifiers to the provider", async () => {
    const f = fakeFetch(good);
    await llm(f).classify(input("book for acne", "Dermatology"));
    const body = (f.mock.calls[0] as unknown as [string, RequestInit])[1].body as string;
    expect(body).not.toMatch(/Rahul|98765|\+91/);
    expect(body).toContain("book for acne");
  });

  it("rejects departments that were not offered", async () => {
    const out = JSON.stringify({ ...JSON.parse(good), department: "neurosurgery" });
    const r = await llm(fakeFetch(out)).classify(input("book appointment"));
    expect(r.department).toBe(NEEDS_HUMAN_REVIEW);
    expect(r.priority_for_human_review).toBe("review");
  });

  it("safety net overrides a model that missed an emergency", async () => {
    const r = await llm(fakeFetch(good)).classify(input("severe chest pain, want appointment", "Cardiology"));
    expect(r).toMatchObject({ emergency: true, enquiry_type: "emergency", priority_for_human_review: "review" });
  });

  it("tolerates code fences", () => {
    expect(extractJson("```json\n{\"a\":1}\n```")).toEqual({ a: 1 });
  });

  it.each([
    ["garbage text", fakeFetch("sorry, I cannot help")],
    ["schema mismatch", fakeFetch(JSON.stringify({ department: "x" }))],
    ["HTTP 500", fakeFetch(null, 500)],
    ["empty completion", fakeFetch(null)],
  ])("falls back to rules on %s", async (_label, f) => {
    setLeadClassifierForTests(llm(f));
    try {
      const { result, fallbackReason } = await classifyLead(input("book for acne", "Dermatology"));
      expect(fallbackReason).toBeTruthy();
      expect(result.provider).toBe("rules_fallback");
      expect(result.department).toBe("dermatology");
    } finally {
      setLeadClassifierForTests(undefined);
    }
  });
});

describe("tolerating model quirks", () => {
  it("accepts null for optional fields, as some models send", async () => {
    const out = JSON.stringify({
      department: "dermatology",
      enquiry_type: "appointment_booking",
      priority_for_human_review: "normal",
      missing_information: null,
      reason: null,
    });
    const r = await llm(fakeFetch(out)).classify(input("book for acne", "Dermatology"));
    expect(r).toMatchObject({ department: "dermatology", reason: "", missing_information: [] });
  });

  it("explains a truncated answer instead of saying 'empty'", async () => {
    const truncated = vi.fn(async () =>
      new Response(JSON.stringify({ choices: [{ finish_reason: "length", message: { content: null } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ) as unknown as typeof fetch;
    await expect(llm(truncated).classify(input("book for acne"))).rejects.toThrow(/ran out of output tokens/);
  });
});
