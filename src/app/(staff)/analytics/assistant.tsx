"use client";

import { useEffect, useRef, useState } from "react";
import { Icons } from "@/components/icons";
import { askAction } from "./assistant-actions";

interface Turn {
  role: "user" | "assistant";
  content: string;
}

const SUGGESTIONS = [
  "How many patients did we see this week?",
  "What is on the calendar tomorrow?",
  "Which medicines are low or expired?",
  "Who is admitted right now?",
  "How much money is unpaid and who owes the most?",
  "Which doctor has the longest waiting time?",
];

/** Models sometimes answer in markdown anyway: show **bold** as bold and drop stray heading marks. */
function Rich({ text }: { text: string }) {
  const clean = text.replace(/^#{1,6}\s+/gm, "").replace(/^\s*[-*]\s+/gm, "• ");
  return (
    <>
      {clean.split(/\*\*(.+?)\*\*/g).map((part, i) => (i % 2 ? <strong key={i}>{part}</strong> : part.replace(/\*/g, "")))}
    </>
  );
}

export function AssistantChat() {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const end = useRef<HTMLDivElement>(null);

  useEffect(() => {
    end.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [turns, busy]);

  async function send(q: string) {
    const question = q.trim();
    if (!question || busy) return;
    const history = turns;
    setTurns((t) => [...t, { role: "user", content: question }]);
    setText("");
    setBusy(true);
    try {
      const { answer } = await askAction(question, history);
      setTurns((t) => [...t, { role: "assistant", content: answer }]);
    } catch {
      setTurns((t) => [...t, { role: "assistant", content: "Something went wrong. Please try again." }]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col">
      <div className="max-h-96 min-h-40 space-y-3 overflow-y-auto p-4" aria-live="polite">
        {turns.length === 0 && (
          <div className="space-y-3">
            <p className="text-sm text-muted">Ask anything about the hospital: patients, money, stock, beds, enquiries, or the calendar. It reads the live data and cannot change anything.</p>
            <div className="flex flex-wrap gap-2">
              {SUGGESTIONS.map((s) => (
                <button key={s} onClick={() => send(s)} className="rounded-full border border-border px-3 py-1 text-xs text-muted hover:border-primary hover:text-primary">
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
        {turns.map((t, i) => (
          <div key={i} className={`pop-in flex ${t.role === "user" ? "justify-end" : "justify-start"}`}>
            <div className={`max-w-[85%] rounded-2xl px-3.5 py-2 text-sm whitespace-pre-wrap ${t.role === "user" ? "bg-primary text-white" : "bg-surface-2"}`}>
              {t.role === "user" ? t.content : <Rich text={t.content} />}
            </div>
          </div>
        ))}
        {busy && (
          <div className="flex justify-start">
            <div className="skeleton h-9 w-40 rounded-2xl" aria-label="Thinking" />
          </div>
        )}
        <div ref={end} />
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void send(text);
        }}
        className="flex gap-2 border-t border-border p-3"
      >
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          maxLength={800}
          placeholder="Ask about patients, money, stock, beds, the calendar…"
          aria-label="Ask the assistant"
          className="min-w-0 flex-1 rounded-xl border border-border bg-surface px-3.5 py-2 text-sm outline-none"
        />
        <button disabled={busy || !text.trim()} className="grid place-items-center rounded-xl bg-primary px-4 text-sm font-medium text-white disabled:opacity-60">
          <span className="flex items-center gap-1.5">
            <Icons.sparkle width={16} height={16} /> Ask
          </span>
        </button>
      </form>
    </div>
  );
}
