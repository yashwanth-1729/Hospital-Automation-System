import { useVideoConfig } from "remotion";
import { WORDS, type Word } from "../timing";
import { C, fontFamily } from "../theme";
import { useTime } from "./base";

// Short phrases (at most ~6 words, broken at punctuation) read faster than full sentences.
const PHRASES: Word[][] = (() => {
  const out: Word[][] = [];
  let cur: Word[] = [];
  for (const w of WORDS) {
    cur.push(w);
    const end = /[.,?!:]$/.test(w.text) || w.text.endsWith("...");
    if ((end && cur.length >= 2) || cur.length >= 6) {
      out.push(cur);
      cur = [];
    }
  }
  if (cur.length) out.push(cur);
  return out;
})();

const clean = (s: string) => s.replace(/\.\.\./g, "").replace(/H\.M\.S\./g, "HMS").replace(/A\.I\./g, "AI");

/** Quiet captions for people watching with the sound off. Spoken words light up as they are said. */
export function Captions({ hideBefore = 0, hideAfter = Infinity }: { hideBefore?: number; hideAfter?: number }) {
  const t = useTime();
  useVideoConfig();
  if (t < hideBefore || t > hideAfter) return null;
  const phrase = PHRASES.find((p) => t >= p[0]!.start - 0.05 && t <= p[p.length - 1]!.end + 0.25);
  if (!phrase) return null;
  return (
    <div style={{ position: "absolute", left: 0, right: 0, bottom: 64, display: "flex", justifyContent: "center", pointerEvents: "none" }}>
      <div
        style={{
          fontFamily,
          fontSize: 34,
          fontWeight: 600,
          letterSpacing: "-0.01em",
          padding: "12px 22px",
          borderRadius: 16,
          background: "rgba(255,255,255,0.86)",
          boxShadow: "0 8px 30px -14px rgba(6,60,40,0.35)",
          backdropFilter: "blur(8px)",
          maxWidth: 920,
          textAlign: "center",
          lineHeight: 1.3,
        }}
      >
        {phrase.map((w, i) => (
          <span key={i} style={{ color: t >= w.start ? C.ink : "#A9BBB2", transition: "none" }}>
            {clean(w.text)}
            {i < phrase.length - 1 ? " " : ""}
          </span>
        ))}
      </div>
    </div>
  );
}
