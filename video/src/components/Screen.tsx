import { useMemo } from "react";
import { interpolate, OffthreadVideo, staticFile, useVideoConfig } from "remotion";
import { C, easeOut, fontFamily, shadow } from "../theme";
import { progress, useTime } from "./base";

export interface Mark {
  t: number;
  kind: string;
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface Recording {
  width: number;
  height: number;
  duration: number;
  marks: Mark[];
}

/** A camera keyframe in page coordinates (CSS px of the recording). */
export interface Shot {
  t: number; // clip time
  x: number;
  y: number;
  zoom: number;
}

/**
 * The real product in a quiet browser frame. The camera glides to wherever the cursor went
 * (from the recorder's marks), or follows explicit shots, Screen Studio style.
 */
export function Screen({
  name,
  rec,
  from = 0,
  rate = 1,
  width = 960,
  height = 680,
  enter = 0,
  zoom = 1.75,
  wide = 1.05,
  shots,
  leadIn = 0.25,
  focusX = 0.5,
}: {
  name: string;
  rec: Recording;
  from?: number;
  rate?: number;
  width?: number;
  height?: number;
  enter?: number;
  zoom?: number;
  wide?: number;
  shots?: Shot[];
  leadIn?: number;
  /** Where across the frame the subject sits (0.5 = centre). Lower keeps it clear of a phone on the right. */
  focusX?: number;
}) {
  const t = useTime();
  const { fps, durationInFrames } = useVideoConfig();
  const bar = 44;
  const viewH = height - bar;
  const base = width / rec.width;

  // Where the camera wants to be at each frame, then smoothed like a real operator's hand.
  const path = useMemo(() => {
    const target = (clip: number) => {
      if (shots?.length) {
        let s = shots[0]!;
        for (const k of shots) if (k.t <= clip) s = k;
        return s;
      }
      const marks = rec.marks.filter((m) => m.t <= clip + leadIn);
      const m = marks[marks.length - 1];
      if (!m) return { x: rec.width / 2, y: (rec.height * 0.42), zoom: wide };
      return { x: m.x + Math.min(m.w, 420) / 2, y: m.y + m.h / 2, zoom };
    };
    const out: { x: number; y: number; z: number }[] = [];
    let cur = target(from);
    let x = cur.x;
    let y = cur.y;
    let z = cur.zoom;
    const n = Math.max(durationInFrames, 1);
    for (let f = 0; f < n; f++) {
      const clip = from + (f / fps) * rate;
      const goal = target(clip);
      const k = 1 - Math.exp(-(1 / fps) * 4.2); // critically damped feel, ~0.5 s to settle
      x += (goal.x - x) * k;
      y += (goal.y - y) * k;
      z += (goal.zoom - z) * k * 0.85;
      // Keep the view inside the page.
      const sc = base * z;
      const loX = (width * focusX) / sc;
      const hiX = rec.width - (width * (1 - focusX)) / sc;
      const vh = viewH / sc;
      const cx = loX > hiX ? rec.width / 2 : Math.min(Math.max(x, loX), hiX);
      const cy = vh >= rec.height ? rec.height / 2 : Math.min(Math.max(y, vh / 2), rec.height - vh / 2);
      out.push({ x: cx, y: cy, z });
    }
    return out;
  }, [rec, from, rate, shots, zoom, wide, leadIn, focusX, fps, durationInFrames, width, viewH, base]);

  const f = Math.min(Math.round(t * fps), path.length - 1);
  const cam = path[f]!;
  const s = base * cam.z;
  const left = width * focusX - cam.x * s;
  const top = viewH / 2 - cam.y * s;

  const p = progress(t, enter, 0.9, easeOut);
  return (
    <div
      style={{
        width,
        height,
        borderRadius: 22,
        overflow: "hidden",
        background: C.surface,
        border: `1px solid ${C.line}`,
        boxShadow: shadow.float,
        opacity: p,
        transform: `perspective(1600px) translateY(${(1 - p) * 70}px) rotateX(${(1 - p) * 10}deg) scale(${0.96 + p * 0.04})`,
        transformOrigin: "50% 100%",
      }}
    >
      <div style={{ height: bar, display: "flex", alignItems: "center", gap: 8, padding: "0 18px", borderBottom: `1px solid ${C.line}`, background: "#FBFDFC" }}>
        {["#E8EFEB", "#E8EFEB", "#E8EFEB"].map((c, i) => (
          <span key={i} style={{ width: 11, height: 11, borderRadius: 11, background: c }} />
        ))}
        <span style={{ flex: 1 }} />
        <span style={{ fontFamily, fontSize: 15, fontWeight: 600, color: C.muted, letterSpacing: "0.01em" }}>Clevo</span>
        <span style={{ flex: 1 }} />
        <span style={{ width: 52 }} />
      </div>
      <div style={{ position: "relative", width, height: viewH, overflow: "hidden", background: C.bg }}>
        <OffthreadVideo
          src={staticFile(`rec/${name}.mp4`)}
          startFrom={Math.round(from * fps)}
          playbackRate={rate}
          muted
          style={{ position: "absolute", left, top, width: rec.width * s, height: rec.height * s, maxWidth: "none" }}
        />
      </div>
    </div>
  );
}

/** A soft ring that draws attention to one thing on screen, then lets go. */
export function Ring({ x, y, w, h, start, end }: { x: number; y: number; w: number; h: number; start: number; end: number }) {
  const t = useTime();
  const pin = progress(t, start, 0.5);
  const pout = interpolate(t, [end - 0.3, end], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return (
    <div
      style={{
        position: "absolute",
        left: x - 10,
        top: y - 10,
        width: w + 20,
        height: h + 20,
        borderRadius: 16,
        border: `3px solid ${C.accent}`,
        boxShadow: `0 0 0 8px ${C.glow}`,
        opacity: pin * pout,
        transform: `scale(${1.08 - pin * 0.08})`,
      }}
    />
  );
}
