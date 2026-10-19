"use server";

import { pool } from "@/lib/db";
import { requireStaff } from "@/server/auth/guard";
import { askAssistant, type ChatTurn } from "@/server/ai/assistant";

const asked = new Map<string, number[]>();

/** The administrator's assistant. Read-only, admin only, checked here against the database. */
export async function askAction(question: string, history: ChatTurn[]): Promise<{ answer: string }> {
  const user = await requireStaff("assistant.use");
  // Each question costs money: at most 12 a minute per person.
  const now = Date.now();
  const recent = (asked.get(user.user_id) ?? []).filter((t) => now - t < 60_000);
  if (recent.length >= 12) return { answer: "That is a lot of questions at once. Please wait a moment and ask again." };
  asked.set(user.user_id, [...recent, now]);
  const clean = (Array.isArray(history) ? history : [])
    .filter((t) => t && (t.role === "user" || t.role === "assistant") && typeof t.content === "string")
    .map((t) => ({ role: t.role, content: t.content }));
  const { answer } = await askAssistant(pool(), String(question ?? ""), clean);
  return { answer };
}
