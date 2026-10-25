import type { CSSProperties, ReactNode } from "react";
import { AbsoluteFill, Img, interpolate, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { C, easeOut, fontFamily } from "../theme";

/** Seconds since the start of the enclosing Sequence. */
export function useTime(): number {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return frame / fps;
}

/** 0 → 1 between two times, eased out. */
export function progress(t: number, start: number, dur = 0.7, ease = easeOut): number {
  return interpolate(t, [start, start + dur], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: ease });
}

/** Warm off-white with two slow mint glows and a fine dot grid. Never competes with the content. */
export function Background() {
  const t = useTime();
  const drift = Math.sin(t * 0.18) * 40;
  return (
    <AbsoluteFill style={{ background: C.bg, overflow: "hidden" }}>
      <div
        style={{
          position: "absolute",
          inset: -200,
          background: `radial-gradient(700px 520px at ${18 + drift / 30}% ${8 + drift / 60}%, ${C.accentSoft}, transparent 70%),
                       radial-gradient(640px 560px at ${92 - drift / 40}% ${96 - drift / 80}%, #E2F1E8, transparent 70%)`,
        }}
      />
      <div
        style={{
          position: "absolute",
          inset: 0,
          backgroundImage: `radial-gradient(${C.line} 1.2px, transparent 1.2px)`,
          backgroundSize: "28px 28px",
          opacity: 0.55,
          maskImage: "radial-gradient(ellipse at 50% 40%, black 30%, transparent 78%)",
          WebkitMaskImage: "radial-gradient(ellipse at 50% 40%, black 30%, transparent 78%)",
        }}
      />
    </AbsoluteFill>
  );
}

/** Words rise into place one after another. */
export function Rise({
  text,
  start,
  size,
  weight = 800,
  color = C.ink,
  stagger = 0.06,
  style,
  accent = [],
  align = "left",
  lineHeight = 1.04,
}: {
  text: string;
  start: number;
  size: number;
  weight?: number;
  color?: string;
  stagger?: number;
  style?: CSSProperties;
  accent?: string[];
  align?: "left" | "center";
  lineHeight?: number;
}) {
  const t = useTime();
  const words = text.split(" ");
  return (
    <div style={{ fontFamily, fontSize: size, fontWeight: weight, color, lineHeight, letterSpacing: "-0.035em", textAlign: align, ...style }}>
      {words.map((w, i) => {
        const p = progress(t, start + i * stagger, 0.75);
        const isAccent = accent.includes(w.replace(/[^\w-]/g, ""));
        return (
          <span
            key={i}
            style={{ display: "inline-block", overflow: "hidden", verticalAlign: "top", paddingBottom: size * 0.08, marginBottom: -size * 0.08, marginRight: i < words.length - 1 ? "0.26em" : 0 }}
          >
            <span
              style={{
                display: "inline-block",
                transform: `translateY(${(1 - p) * 105}%)`,
                opacity: p,
                color: isAccent ? C.accent : undefined,
              }}
            >
              {w}
            </span>
          </span>
        );
      })}
    </div>
  );
}

export function Kicker({ children, start }: { children: ReactNode; start: number }) {
  const t = useTime();
  const p = progress(t, start, 0.6);
  return (
    <div
      style={{
        fontFamily,
        display: "inline-flex",
        alignItems: "center",
        gap: 12,
        fontSize: 24,
        fontWeight: 700,
        letterSpacing: "0.16em",
        textTransform: "uppercase",
        color: C.accent,
        opacity: p,
        transform: `translateY(${(1 - p) * 12}px)`,
      }}
    >
      <span style={{ width: 34, height: 3, borderRadius: 3, background: C.accent, transform: `scaleX(${p})`, transformOrigin: "left" }} />
      {children}
    </div>
  );
}

export function Logo({ size }: { size: number }) {
  return <Img src={staticFile("clevo-logo.png")} style={{ width: size, height: size }} />;
}

/** Fades the whole scene out over its last moments, so cuts feel like breaths. */
export function SceneFade({ duration, children }: { duration: number; children: ReactNode }) {
  const t = useTime();
  const out = interpolate(t, [duration - 0.35, duration], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const lift = interpolate(t, [duration - 0.35, duration], [0, -18], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return <AbsoluteFill style={{ opacity: out, transform: `translateY(${lift}px)` }}>{children}</AbsoluteFill>;
}
