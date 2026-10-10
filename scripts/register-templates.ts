import "../src/lib/load-env";
import { env } from "../src/lib/env";
import { TEMPLATES, type TemplateDef } from "../src/server/messaging/templates";

/**
 * Submits every patient-facing template to Meta for approval.
 *
 *   npx tsx scripts/register-templates.ts            # show what would be sent (default)
 *   npx tsx scripts/register-templates.ts --submit   # create the ones that do not exist yet
 *
 * Needs WA_BUSINESS_ACCOUNT_ID (the WhatsApp Business Account id, not the phone number id)
 * and WA_ACCESS_TOKEN. Meta reviews each template, usually within minutes; messages cannot be
 * sent with a template until it is approved. Existing templates are never modified or deleted.
 */

// Meta requires a realistic example for every variable. Only used for review.
const EXAMPLES: Record<string, string> = {
  patient_name: "Rahul Sharma",
  hospital_name: "DemoCare Multispeciality Hospital",
  hospital_contact: "+91 80000 00000",
  emergency_number: "108",
  department: "Cardiology",
  doctor_name: "Dr. Ananya Rao",
  slot: "Mon, 12 Oct 2026, 10:30 AM",
  missed_slot: "Mon, 12 Oct 2026, 10:30 AM",
  appointment_id: "APT-7K2M9QX4TB",
  options: "Tue, 13 Oct 2026, 11:00 AM",
  followup_date: "Fri, 16 Oct 2026",
  feedback_link: "https://care.example.com/r/abc123",
  next_step: "Your prescription is ready at our pharmacy counter.",
  amount: "₹500.00",
  invoice_number: "INV-2026-000123",
  balance_line: "Balance due: ₹522.25.",
  balance: "₹522.25",
};

function body(def: TemplateDef): { text: string; example: string[] } {
  const marks = Object.fromEntries(def.params.map((p, i) => [p, `{{${i + 1}}}`]));
  return { text: def.render(marks), example: def.params.map((p) => EXAMPLES[p] ?? "Sample") };
}

/**
 * Meta rejects a body that opens or closes with a variable, or has two variables side by side.
 * Punctuation after a final variable ("call {{1}}.") is accepted.
 */
function problems(text: string): string[] {
  const out: string[] = [];
  if (/^\s*\{\{\d+\}\}/.test(text)) out.push("starts with a variable");
  if (/\{\{\d+\}\}\s*$/.test(text)) out.push("ends with a variable");
  if (/\{\{\d+\}\}\s*\{\{\d+\}\}/.test(text)) out.push("has adjacent variables");
  if (text.length > 1024) out.push("is longer than 1024 characters");
  return out;
}

async function main() {
  const submit = process.argv.includes("--submit");
  const e = env();
  const language = e.WA_TEMPLATE_LANGUAGE;

  const rows = Object.entries(TEMPLATES).map(([key, def]) => {
    const t = def as TemplateDef;
    return { key, def: t, ...body(t) };
  });

  let bad = 0;
  for (const r of rows) {
    const p = problems(r.text);
    if (p.length) {
      bad += 1;
      console.error(`x ${r.def.providerName}: ${p.join(", ")}`);
    }
  }
  if (bad) {
    console.error(`\n${bad} template(s) would be rejected by Meta. Fix the wording in src/server/messaging/templates.ts first.`);
    process.exit(1);
  }

  if (!submit) {
    console.log(`${rows.length} templates (language ${language}). Nothing is sent without --submit.\n`);
    for (const r of rows) {
      console.log(`- ${r.def.providerName}  [${r.def.category}]  ${r.def.params.length} variable(s)`);
      console.log(`    ${r.text.replace(/\n/g, "\n    ")}\n`);
    }
    return;
  }

  if (!e.WA_BUSINESS_ACCOUNT_ID || !e.WA_ACCESS_TOKEN) {
    console.error("Set WA_BUSINESS_ACCOUNT_ID and WA_ACCESS_TOKEN in .env first.");
    process.exit(1);
  }
  const base = `https://graph.facebook.com/${e.WA_API_VERSION}/${e.WA_BUSINESS_ACCOUNT_ID}/message_templates`;
  const headers = { Authorization: `Bearer ${e.WA_ACCESS_TOKEN}`, "Content-Type": "application/json" };

  const existing = new Set<string>();
  for (let url: string | null = `${base}?fields=name,language,status&limit=200`; url; ) {
    const res: Response = await fetch(url, { headers });
    const json = (await res.json()) as { data?: { name: string; language: string }[]; paging?: { next?: string }; error?: { message: string } };
    if (!res.ok) throw new Error(`Could not list templates: ${json.error?.message ?? res.status}`);
    for (const t of json.data ?? []) existing.add(`${t.name}:${t.language}`);
    url = json.paging?.next ?? null;
  }

  for (const r of rows) {
    const id = `${r.def.providerName}:${language}`;
    if (existing.has(id)) {
      console.log(`= ${r.def.providerName}: already exists`);
      continue;
    }
    const res = await fetch(base, {
      method: "POST",
      headers,
      body: JSON.stringify({
        name: r.def.providerName,
        language,
        category: r.def.category.toUpperCase(),
        components: [{ type: "BODY", text: r.text, ...(r.example.length ? { example: { body_text: [r.example] } } : {}) }],
      }),
    });
    const json = (await res.json()) as { id?: string; status?: string; error?: { message: string; error_user_msg?: string } };
    if (res.ok) console.log(`+ ${r.def.providerName}: submitted (${json.status ?? "PENDING"})`);
    else console.error(`x ${r.def.providerName}: ${json.error?.error_user_msg ?? json.error?.message ?? res.status}`);
  }
}

main().catch((err) => {
  console.error((err as Error).message);
  process.exit(1);
});
