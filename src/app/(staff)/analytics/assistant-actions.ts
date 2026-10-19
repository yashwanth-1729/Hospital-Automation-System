"use server";

import { pool } from "@/lib/db";
import { requireStaff } from "@/server/auth/guard";
import { askAssistant, type ChatTurn } from "@/server/ai/assistant";

/** The administrator's assistant. Read-only, admin only, checked here against the database. */
export async function askAction(question: string, history: ChatTurn[]): Promise<{ answer: string }> {
  await requireStaff("assistant.use");
  const { answer } = await askAssistant(pool(), question, history);
  return { answer };
}
