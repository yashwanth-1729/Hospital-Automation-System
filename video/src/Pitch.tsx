import { useMemo, type ReactNode } from "react";
import { AbsoluteFill, Audio, interpolate, Sequence, staticFile, useVideoConfig } from "remotion";
import { Background, Kicker, Logo, progress, Rise, SceneFade, useTime } from "./components/base";
import { Captions } from "./components/Captions";
import { Phone, type Bubble } from "./components/Phone";
import { Screen, type Recording } from "./components/Screen";
import { C, fontFamily, FPS, shadow } from "./theme";
import { at, T, TOTAL, VO_START, WORDS } from "./timing";
import analytics from "../public/rec/analytics.json";
import billing from "../public/rec/billing.json";
import care from "../public/rec/care.json";
import doctor from "../public/rec/doctor.json";
import enquiry from "../public/rec/enquiry.json";
import followups from "../public/rec/followups.json";
import labs from "../public/rec/labs.json";
import reports from "../public/rec/reports.json";

const R = (r: unknown) => r as Recording;

/** A scene placed on the master timeline in seconds. Each scene has its own clock. */
function Scene({ from, to, children, fade = true }: { from: number; to: number; children: ReactNode; fade?: boolean }) {
  const { fps } = useVideoConfig();
  const start = Math.round(from * fps);
  const dur = Math.max(1, Math.round(to * fps) - start);
  return (
    <Sequence from={start} durationInFrames={dur} layout="none">
      {fade ? <SceneFade duration={to - from}>{children}</SceneFade> : <AbsoluteFill>{children}</AbsoluteFill>}
    </Sequence>
  );
}

/** Kicker and headline in the top band of a scene. */
function Head({ kicker, title, accent, start = 0.05, size = 78 }: { kicker: string; title: string; accent?: string[]; start?: number; size?: number }) {
  return (
    <div style={{ position: "absolute", left: 72, right: 72, top: 96 }}>
      <Kicker start={start}>{kicker}</Kicker>
      <div style={{ height: 22 }} />
      <Rise text={title} start={start + 0.12} size={size} accent={accent} />
    </div>
  );
}

// --- timings derived from the voice ---------------------------------------------------------------

const FRONT = { from: 3.2, rate: 1.5 }; // enquiry clip: skip to department, submit lands ~4.8 s in
const ENQ_SUBMIT = T.front + (10.38 - FRONT.from) / FRONT.rate;
const OWNER_SPLIT = T.assistant - 1.5;

const BUBBLES = {
  confirm: Math.max(ENQ_SUBMIT + 0.5, T.books),
  reminder: T.reminders + 0.5,
  care: at("reminded before", T.between),
  labs: T.labs + 0.9,
  noshow: T.noshow + 1.4,
};

const MSG = {
  confirm:
    "Hello Priya, your appointment at Clevo Demo Hospital is confirmed.\nDepartment: Cardiology\nDoctor: Dr. Ananya Rao\nDate & time: Tue, 27 Oct, 10:30 AM\nPlease arrive 15 minutes early.",
  reminder: "Reminder: Priya, you have an appointment at Clevo Demo Hospital with Dr. Ananya Rao tomorrow at 10:30 AM.",
  care: "Hello Ramesh, your regular diabetes check-up at Clevo Demo Hospital is due on Thu, 29 Oct. Regular reviews help keep your health on track.",
  lab: "Hello Lakshmi, your HbA1c report from Clevo Demo Hospital is ready. Please visit your doctor to go through the results.",
  noshow:
    "Hello Arjun, we missed you at Clevo Demo Hospital for your appointment with Dr. Kavya Pillai.\nWould you like to reschedule? Next available: Wed, 28 Oct, 11:00 AM",
};

// --- 1. The problem --------------------------------------------------------------------------------

function Hook() {
  const t = useTime();
  const dots = Array.from({ length: 9 * 6 }, (_, i) => ({ c: i % 9, r: Math.floor(i / 9) }));
  const slip = at("slip away");
  const items: [number, string][] = [
    [T.missed, "A missed call"],
    [T.followup, "A follow-up nobody made"],
    [T.report, "A report nobody chased"],
  ];
  const dim = interpolate(t, [T.missed - 0.3, T.missed + 0.4], [1, 0.3], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return (
    <AbsoluteFill>
      <div style={{ position: "absolute", left: 72, right: 72, top: 230, textAlign: "center" }}>
        <Rise text="Every hospital works hard to treat its patients." start={VO_START} size={40} weight={600} color={C.ink2} align="center" stagger={0.045} />
        <div style={{ height: 30 }} />
        <Rise text="Between visits, patients slip away." start={at("But between visits")} size={98} align="center" accent={["away"]} stagger={0.1} />
      </div>
      {/* Patients as dots: a few quietly drift out of care. */}
      <div style={{ position: "absolute", left: 180, top: 720, width: 720, height: 400, opacity: dim * progress(t, 1.2, 1.2) }}>
        {dots.map(({ c, r }, i) => {
          const leaves = (c * 7 + r * 3) % 5 === 0;
          const q = leaves ? progress(t, slip + (i % 7) * 0.12, 2.2) : 0;
          return (
            <span
              key={i}
              style={{
                position: "absolute",
                left: c * 86,
                top: r * 76,
                width: 16,
                height: 16,
                borderRadius: 16,
                background: leaves && q > 0.02 ? C.coral : C.accent,
                opacity: (leaves ? 1 - q : 0.85) * 0.8,
                transform: `translate(${q * (60 + (i % 4) * 30)}px, ${q * (40 + (i % 3) * 25)}px) scale(${1 - q * 0.5})`,
              }}
            />
          );
        })}
      </div>
      <div style={{ position: "absolute", left: 0, right: 0, top: 760, display: "flex", flexDirection: "column", alignItems: "center", gap: 18 }}>
        {items.map(([when, label]) => {
          const p = progress(t, when, 0.6);
          return (
            <div
              key={label}
              style={{
                fontFamily,
                display: "flex",
                alignItems: "center",
                gap: 16,
                padding: "18px 30px 18px 22px",
                borderRadius: 999,
                background: C.surface,
                boxShadow: shadow.card,
                border: `1px solid ${C.line}`,
                fontSize: 36,
                fontWeight: 700,
                color: C.ink,
                letterSpacing: "-0.02em",
                opacity: p,
                transform: `translateY(${(1 - p) * 26}px) scale(${0.96 + p * 0.04})`,
              }}
            >
              <span style={{ width: 34, height: 34, borderRadius: 34, background: C.coralSoft, color: C.coral, display: "grid", placeItems: "center", fontSize: 22, fontWeight: 800 }}>✕</span>
              {label}
            </div>
          );
        })}
      </div>
    </AbsoluteFill>
  );
}

// --- 2. What Clevo is ------------------------------------------------------------------------------

function Node({ x, label, sub, start, children, lit = 0 }: { x: number; label: string; sub: string; start: number; children: ReactNode; lit?: number }) {
  const t = useTime();
  const p = progress(t, start, 0.7);
  return (
    <div style={{ position: "absolute", left: x - 135, top: 640, width: 270, textAlign: "center", opacity: p, transform: `translateY(${(1 - p) * 30}px)` }}>
      <div
        style={{
          width: 270,
          height: 230,
          borderRadius: 32,
          background: C.surface,
          border: `1px solid ${lit > 0.01 ? C.accent : C.line}`,
          boxShadow: lit > 0.01 ? `0 0 0 ${8 * lit}px ${C.glow}, ${shadow.card}` : shadow.card,
          display: "grid",
          placeItems: "center",
        }}
      >
        {children}
      </div>
      <div style={{ fontFamily, marginTop: 22, fontSize: 32, fontWeight: 800, color: C.ink, letterSpacing: "-0.02em" }}>{label}</div>
      <div style={{ fontFamily, marginTop: 4, fontSize: 22, fontWeight: 500, color: C.muted }}>{sub}</div>
    </div>
  );
}

function Wire({ x1, x2, start }: { x1: number; x2: number; start: number }) {
  const t = useTime();
  const p = progress(t, start, 0.6);
  const len = x2 - x1;
  return (
    <div style={{ position: "absolute", left: x1, top: 754, width: len, height: 4 }}>
      <div style={{ position: "absolute", inset: 0, borderRadius: 4, background: C.line }} />
      <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: `${p * 100}%`, borderRadius: 4, background: C.accent, opacity: 0.35 }} />
      {p >= 1 &&
        [0, 0.33, 0.66].map((o) => {
          const k = (((t * 0.55 + o) % 1) + 1) % 1;
          return <span key={o} style={{ position: "absolute", top: -5, left: k * len - 7, width: 14, height: 14, borderRadius: 14, background: C.accent, opacity: Math.sin(k * Math.PI) }} />;
        })}
    </div>
  );
}

function Intro({ from }: { from: number }) {
  const t = useTime();
  const plugs = T.plugs - from;
  const wa = T.whatsapp - from;
  const pop = progress(t, 0.05, 0.9);
  const up = progress(t, plugs - 0.55, 0.9);
  const ring = progress(t, 0.1, 1.6);
  return (
    <AbsoluteFill>
      <div style={{ position: "absolute", left: 0, right: 0, top: interpolate(up, [0, 1], [400, 150]), display: "flex", flexDirection: "column", alignItems: "center" }}>
        <div style={{ position: "relative", transform: `scale(${interpolate(up, [0, 1], [1, 0.62]) * (0.7 + pop * 0.3)})`, opacity: pop }}>
          <span
            style={{ position: "absolute", left: "50%", top: "50%", width: 180, height: 180, marginLeft: -90, marginTop: -90, borderRadius: 999, border: `2px solid ${C.accent}`, opacity: (1 - ring) * 0.6, transform: `scale(${1 + ring * 1.2})` }}
          />
          <Logo size={180} />
        </div>
        <div style={{ marginTop: interpolate(up, [0, 1], [26, 0]), transform: `scale(${interpolate(up, [0, 1], [1, 0.7])})` }}>
          <Rise text="Clevo" start={0.35} size={124} align="center" stagger={0} />
        </div>
        <div style={{ marginTop: 10, opacity: progress(t, 1.0, 0.8) }}>
          <div style={{ fontFamily, fontSize: 34, fontWeight: 600, color: C.ink2, letterSpacing: "-0.01em" }}>The AI follow-up layer for hospitals</div>
        </div>
      </div>
      {/* Your HMS → Clevo → WhatsApp: the three appear as "plugs into" is said; WhatsApp lights up when named. */}
      <Node x={190} label="Your HMS" sub="the system you use" start={plugs}>
        <div style={{ width: 170 }}>
          {[0, 1, 2, 3].map((i) => (
            <div key={i} style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 14 }}>
              <span style={{ width: 22, height: 22, borderRadius: 6, background: C.accentSoft }} />
              <span style={{ flex: 1, height: 10, borderRadius: 10, background: "#E6EEE9" }} />
            </div>
          ))}
        </div>
      </Node>
      <Wire x1={325} x2={405} start={plugs + 0.35} />
      <Node x={540} label="Clevo" sub="follows up for you" start={plugs + 0.4} lit={progress(t, plugs + 0.9, 0.6) * (1 - progress(t, wa - 0.2, 0.5))}>
        <Logo size={130} />
      </Node>
      <Wire x1={675} x2={755} start={plugs + 0.75} />
      <Node x={890} label="WhatsApp" sub="where patients are" start={plugs + 0.8} lit={progress(t, wa - 0.2, 0.5)}>
        <div style={{ display: "flex", flexDirection: "column", gap: 10, width: 170 }}>
          {[150, 110, 130].map((w, i) => (
            <span key={i} style={{ alignSelf: i === 1 ? "flex-end" : "flex-start", width: w, height: 30, borderRadius: 14, background: i === 1 ? C.accentSoft : "#EEF3F0" }} />
          ))}
        </div>
      </Node>
    </AbsoluteFill>
  );
}

// --- product scenes --------------------------------------------------------------------------------

function ProductScene({ kicker, title, accent, screen, bubbles, phoneAt = 0.6 }: { kicker: string; title: string; accent?: string[]; screen: ReactNode; bubbles?: Bubble[]; phoneAt?: number }) {
  return (
    <AbsoluteFill>
      <Head kicker={kicker} title={title} accent={accent} />
      <div style={{ position: "absolute", left: 40, top: 372 }}>{screen}</div>
      {bubbles && (
        <div style={{ position: "absolute", left: 724, top: 432 }}>
          <Phone bubbles={bubbles} enter={phoneAt} />
        </div>
      )}
    </AbsoluteFill>
  );
}

function Wide({ kicker, title, accent, children, size = 70 }: { kicker: string; title: string; accent?: string[]; children: ReactNode; size?: number }) {
  return (
    <AbsoluteFill>
      <Head kicker={kicker} title={title} accent={accent} size={size} />
      <div style={{ position: "absolute", left: 44, top: 380 }}>{children}</div>
    </AbsoluteFill>
  );
}

// --- 5. Safety net ---------------------------------------------------------------------------------

function Safety() {
  const t = useTime();
  const cards: [string, string, string, string][] = [
    ["Abnormal HbA1c result", "Lakshmi Reddy · reported 2 min ago", "Doctor", C.coral],
    ["Review overdue, two reminders sent", "Ramesh Kulkarni · diabetes", "Front desk", C.warn],
    ["Patient asked a question", "Anil Joshi · replied on WhatsApp", "Front desk", C.accent],
  ];
  return (
    <AbsoluteFill>
      <Head kicker="A person, when it matters" title="Nothing falls through the cracks." accent={["cracks"]} size={74} />
      <div style={{ position: "absolute", left: 90, right: 90, top: 470, display: "flex", flexDirection: "column", gap: 26 }}>
        {cards.map(([title, sub, who, color], i) => {
          const p = progress(t, 0.5 + i * 0.55, 0.7);
          return (
            <div
              key={title}
              style={{
                fontFamily,
                display: "flex",
                alignItems: "center",
                gap: 22,
                padding: "28px 30px",
                borderRadius: 26,
                background: C.surface,
                border: `1px solid ${C.line}`,
                boxShadow: shadow.card,
                opacity: p,
                transform: `translateX(${(1 - p) * 60}px)`,
              }}
            >
              <span style={{ width: 16, height: 16, borderRadius: 16, background: color, boxShadow: `0 0 0 7px ${color}22` }} />
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 32, fontWeight: 700, color: C.ink, letterSpacing: "-0.02em" }}>{title}</div>
                <div style={{ fontSize: 23, color: C.muted, marginTop: 4 }}>{sub}</div>
              </div>
              <span style={{ fontSize: 22, fontWeight: 700, color: C.accentDeep, background: C.accentSoft, padding: "10px 18px", borderRadius: 999 }}>→ {who}</span>
            </div>
          );
        })}
      </div>
    </AbsoluteFill>
  );
}

// --- 6. Full clinic --------------------------------------------------------------------------------

function NoHms() {
  return (
    <AbsoluteFill>
      <div style={{ position: "absolute", left: 72, right: 72, top: 470, textAlign: "center" }}>
        <Rise text="No HMS yet?" start={0.1} size={112} align="center" stagger={0.08} />
        <div style={{ height: 24 }} />
        <Rise text="Clevo runs the whole clinic." start={0.95} size={64} weight={700} align="center" color={C.ink2} accent={["whole"]} />
      </div>
    </AbsoluteFill>
  );
}

const ICON: Record<string, ReactNode> = {
  desk: <path d="M4 16h16M6 16V9h12v7M9 9V6h6v3" />,
  steth: <path d="M7 4v5a4 4 0 0 0 8 0V4M11 13v3a4 4 0 0 0 8 0v-2M19 12a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z" />,
  pill: <path d="M8.5 15.5l7-7a3.5 3.5 0 0 0-5-5l-7 7a3.5 3.5 0 0 0 5 5zM7 9l5 5" />,
  bill: <path d="M7 3h10v18l-2.5-1.5L12 21l-2.5-1.5L7 21zM10 8h4M10 12h4" />,
};

function Modules({ from }: { from: number }) {
  const t = useTime();
  const words = ["Reception", "consultation", "pharmacy", "billing"].map((w) => at(w, T.full) - from);
  const cards: [string, string, string][] = [
    ["Reception", "Tokens & queues", "desk"],
    ["Consultation", "Notes & prescriptions", "steth"],
    ["Pharmacy", "Stock & dispensing", "pill"],
    ["Billing", "Bills & receipts", "bill"],
  ];
  return (
    <AbsoluteFill>
      <Head kicker="No HMS? No problem" title="One system for the whole clinic." accent={["whole"]} size={70} start={0} />
      <div style={{ position: "absolute", left: 72, right: 72, top: 420, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 28 }}>
        {cards.map(([title, sub, icon], i) => {
          const p = progress(t, Math.max(0.1, words[i]! - 0.1), 0.6);
          return (
            <div
              key={title}
              style={{
                fontFamily,
                height: 300,
                borderRadius: 30,
                background: C.surface,
                border: `1px solid ${C.line}`,
                boxShadow: shadow.card,
                padding: "34px 34px",
                display: "flex",
                flexDirection: "column",
                justifyContent: "space-between",
                opacity: p,
                transform: `translateY(${(1 - p) * 36}px) scale(${0.95 + p * 0.05})`,
              }}
            >
              <span style={{ width: 76, height: 76, borderRadius: 22, background: C.accentSoft, display: "grid", placeItems: "center" }}>
                <svg viewBox="0 0 24 24" width="42" height="42" fill="none" stroke={C.accentDeep} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  {ICON[icon]}
                </svg>
              </span>
              <div>
                <div style={{ fontSize: 44, fontWeight: 800, color: C.ink, letterSpacing: "-0.03em" }}>{title}</div>
                <div style={{ fontSize: 26, fontWeight: 500, color: C.muted, marginTop: 6 }}>{sub}</div>
              </div>
            </div>
          );
        })}
      </div>
    </AbsoluteFill>
  );
}

function AllergyAndBill({ from }: { from: number }) {
  const t = useTime();
  const bills = T.bills - from;
  const p = progress(t, bills - 0.15, 0.7);
  const rows: [string, string][] = [
    ["Consultation · Dr. Ananya Rao", "₹900.00"],
    ["Medicines · 2 items", "₹632.50"],
  ];
  return (
    <AbsoluteFill>
      <Head kicker="Built-in safety" title="Allergy checks. Bills that build themselves." accent={["Allergy", "themselves."]} size={64} start={0} />
      <div style={{ position: "absolute", left: 44, top: 380 }}>
        <Screen name="doctor" rec={R(doctor)} from={17.0} shots={[{ t: 0, x: 610, y: 792, zoom: 1.9 }]} width={992} height={720} enter={0} />
      </div>
      {/* The invoice that followed, built from the consultation and the pharmacy. */}
      <div
        style={{
          position: "absolute",
          right: 60,
          top: 790,
          width: 560,
          fontFamily,
          borderRadius: 26,
          background: C.surface,
          border: `1px solid ${C.line}`,
          boxShadow: shadow.float,
          padding: "26px 30px",
          opacity: p,
          transform: `translateY(${(1 - p) * 60}px)`,
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <div style={{ fontSize: 18, fontWeight: 700, color: C.muted, letterSpacing: "0.08em", textTransform: "uppercase" }}>Invoice · built automatically</div>
            <div style={{ fontSize: 26, fontWeight: 700, color: C.ink, marginTop: 4 }}>Priya Sharma</div>
          </div>
          <span style={{ fontSize: 18, fontWeight: 700, color: C.accentDeep, background: C.accentSoft, padding: "8px 14px", borderRadius: 999 }}>Paid · UPI ✓</span>
        </div>
        <div style={{ marginTop: 16, borderTop: `1px solid ${C.line}` }}>
          {rows.map(([k, v]) => (
            <div key={k} style={{ display: "flex", justifyContent: "space-between", padding: "12px 0", fontSize: 22, color: C.ink2, borderBottom: `1px solid ${C.line}` }}>
              <span>{k}</span>
              <span>{v}</span>
            </div>
          ))}
          <div style={{ display: "flex", justifyContent: "space-between", paddingTop: 14, fontSize: 30, fontWeight: 800, color: C.ink, letterSpacing: "-0.02em" }}>
            <span>Total</span>
            <span>₹1,532.50</span>
          </div>
        </div>
      </div>
    </AbsoluteFill>
  );
}

// --- 8. Close --------------------------------------------------------------------------------------

function Close({ from }: { from: number }) {
  const t = useTime();
  const setUp = T.setUp - from;
  const end = T.end - from;
  const first = 1 - progress(t, setUp - 0.3, 0.4);
  const card = progress(t, end - 0.2, 0.9);
  return (
    <AbsoluteFill>
      {t < setUp + 0.1 && (
        <div style={{ position: "absolute", left: 72, right: 72, top: 520, textAlign: "center", opacity: first }}>
          <Rise text="Built. Live. Ready." start={0.15} size={120} align="center" stagger={0.18} accent={["Ready."]} />
        </div>
      )}
      {t >= setUp - 0.3 && t < end && (
        <div style={{ position: "absolute", left: 72, right: 72, top: 500, textAlign: "center", opacity: 1 - progress(t, end - 0.5, 0.4) }}>
          <Rise text="Let's set it up for your hospital." start={setUp} size={92} align="center" stagger={0.07} accent={["your", "hospital."]} />
        </div>
      )}
      {t >= end - 0.2 && (
        <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", opacity: card }}>
          <div style={{ transform: `scale(${0.9 + card * 0.1})` }}>
            <Logo size={190} />
          </div>
          <div style={{ fontFamily, marginTop: 22, fontSize: 120, fontWeight: 800, letterSpacing: "-0.04em", color: C.ink }}>Clevo</div>
          <div style={{ fontFamily, marginTop: 4, fontSize: 32, fontWeight: 600, color: C.ink2 }}>The AI follow-up layer for hospitals</div>
          <div
            style={{
              fontFamily,
              marginTop: 64,
              padding: "24px 40px",
              borderRadius: 999,
              background: C.accent,
              color: "white",
              fontSize: 34,
              fontWeight: 700,
              letterSpacing: "-0.01em",
              boxShadow: `0 20px 50px -18px ${C.accent}`,
              opacity: progress(t, end + 0.5, 0.7),
              transform: `translateY(${(1 - progress(t, end + 0.5, 0.7)) * 20}px)`,
            }}
          >
            Reply to book a 15-minute demo
          </div>
          <div style={{ fontFamily, marginTop: 26, fontSize: 24, fontWeight: 500, color: C.muted, opacity: progress(t, end + 0.9, 0.7) }}>
            Works with your HMS · WhatsApp-native · Live today
          </div>
        </div>
      )}
    </AbsoluteFill>
  );
}

// --- sound -----------------------------------------------------------------------------------------

/** Music sits ~18 dB under the voice and breathes up in the pauses; fades in and out at the ends. */
function Music() {
  const { durationInFrames } = useVideoConfig();
  const env = useMemo(() => {
    const speaking = (t: number) => WORDS.some((w) => t >= w.start - 0.2 && t <= w.end + 0.45);
    const out: number[] = [];
    let v = 0;
    for (let f = 0; f < durationInFrames; f++) {
      const t = f / FPS;
      let goal = speaking(t) ? 0.075 : 0.2;
      if (t > T.end) goal = 0.5;
      v += (goal - v) * (1 - Math.exp(-(1 / FPS) * (goal > v ? 3 : 7)));
      const fadeIn = Math.min(1, t / 1.2);
      const fadeOut = Math.min(1, Math.max(0, (73.3 - t) / 2.6));
      out.push(v * fadeIn * fadeOut);
    }
    return out;
  }, [durationInFrames]);
  return <Audio src={staticFile("audio/music.mp3")} volume={(f) => env[f] ?? 0} />;
}

function Sfx({ at: when, src, volume }: { at: number; src: string; volume: number }) {
  return (
    <Sequence from={Math.max(0, Math.round(when * FPS))} layout="none">
      <Audio src={staticFile(`audio/${src}.mp3`)} volume={volume} />
    </Sequence>
  );
}

/** Clicks the viewer can see on screen, mapped from a recording into master time. */
function clicks(rec: Recording, clipFrom: number, rate: number, sceneFrom: number, sceneTo: number): number[] {
  return rec.marks
    .filter((m) => m.kind === "click")
    .map((m) => sceneFrom + (m.t - clipFrom) / rate)
    .filter((t) => t > sceneFrom + 0.3 && t < sceneTo - 0.3);
}

// --- master timeline -------------------------------------------------------------------------------

export function Pitch() {
  const sfxClicks = [...clicks(R(enquiry), FRONT.from, FRONT.rate, T.front, T.between), ...clicks(R(care), 1, 1.1, T.between, T.labs)];
  const pops = [BUBBLES.confirm, BUBBLES.reminder, BUBBLES.care, BUBBLES.labs, BUBBLES.noshow];
  const whooshes = [T.intro, T.front, T.safety, T.full, T.modules, T.owner, T.close];
  return (
    <AbsoluteFill style={{ background: C.bg }}>
      <Background />
      <Scene from={0} to={T.intro}>
        <Hook />
      </Scene>
      <Scene from={T.intro} to={T.front}>
        <Intro from={T.intro} />
      </Scene>
      <Scene from={T.front} to={T.between}>
        <ProductScene
          kicker="Enquiries & bookings"
          title="Answered in seconds."
          accent={["seconds."]}
          screen={
            <Screen
              name="enquiry"
              rec={R(enquiry)}
              from={FRONT.from}
              rate={FRONT.rate}
              width={672}
              height={720}
              enter={0.1}
              shots={[
                { t: 0, x: 600, y: 330, zoom: 1.45 },
                { t: 6.4, x: 640, y: 440, zoom: 1.55 },
                { t: 10.1, x: 640, y: 560, zoom: 1.5 },
                { t: 10.9, x: 640, y: 200, zoom: 1.7 },
              ]}
            />
          }
          bubbles={[
            { at: BUBBLES.confirm - T.front, text: MSG.confirm, time: "10:02" },
            { at: BUBBLES.reminder - T.front, text: MSG.reminder, time: "10:31" },
          ]}
          phoneAt={ENQ_SUBMIT - T.front - 0.6}
        />
      </Scene>
      <Scene from={T.between} to={T.labs}>
        <ProductScene
          kicker="Chronic care"
          title="Every review, remembered."
          accent={["remembered."]}
          screen={<Screen name="care" rec={R(care)} from={1} rate={1.1} width={672} height={720} enter={0.1} zoom={1.85} focusX={0.5} />}
          bubbles={[{ at: BUBBLES.care - T.between, text: MSG.care, time: "09:00" }]}
          phoneAt={1.5}
        />
      </Scene>
      <Scene from={T.labs} to={T.noshow}>
        <ProductScene
          kicker="Lab follow-ups"
          title="Reports never wait."
          accent={["never"]}
          screen={<Screen name="labs" rec={R(labs)} from={1.6} rate={1.2} width={672} height={720} enter={0} zoom={1.85} focusX={0.5} />}
          bubbles={[{ at: BUBBLES.labs - T.labs, text: MSG.lab, time: "11:42" }]}
          phoneAt={0.15}
        />
      </Scene>
      <Scene from={T.noshow} to={T.safety}>
        <ProductScene
          kicker="No-show recovery"
          title="Missed today. Back this week."
          accent={["Back"]}
          screen={<Screen name="followups" rec={R(followups)} from={0.6} rate={1} width={672} height={720} enter={0} zoom={1.8} focusX={0.5} />}
          bubbles={[{ at: BUBBLES.noshow - T.noshow, text: MSG.noshow, time: "12:15" }]}
          phoneAt={0.4}
        />
      </Scene>
      <Scene from={T.safety} to={T.full}>
        <Safety />
      </Scene>
      <Scene from={T.full} to={T.modules}>
        <NoHms />
      </Scene>
      <Scene from={T.modules} to={T.allergy - 0.1}>
        <Modules from={T.modules} />
      </Scene>
      <Scene from={T.allergy - 0.1} to={T.owner}>
        <AllergyAndBill from={T.allergy - 0.1} />
      </Scene>
      <Scene from={T.owner} to={OWNER_SPLIT}>
        <Wide kicker="For the owner" title="Your hospital, in sixty seconds." accent={["sixty"]}>
          <Screen name="reports" rec={R(reports)} from={1.0} shots={[{ t: 0, x: 1092, y: 470, zoom: 2.05 }]} width={992} height={760} enter={0.05} />
        </Wide>
      </Scene>
      <Scene from={OWNER_SPLIT} to={T.close}>
        <Wide kicker="Ask Clevo" title="Just ask." accent={["ask."]}>
          <Screen name="analytics" rec={R(analytics)} from={7.8} shots={[{ t: 0, x: 580, y: 262, zoom: 1.6 }]} width={992} height={760} enter={0} />
        </Wide>
      </Scene>
      <Scene from={T.close} to={TOTAL} fade={false}>
        <Close from={T.close} />
      </Scene>
      <Captions hideBefore={T.intro} hideAfter={T.close} />

      {/* Sound: voice, music bed, and a few quiet effects tied to what is on screen. */}
      <Sequence from={Math.round(VO_START * FPS)} layout="none">
        <Audio src={staticFile("audio/vo.mp3")} volume={1} />
      </Sequence>
      <Music />
      {whooshes.map((w) => (
        <Sfx key={`w${w}`} at={w - 0.15} src="whoosh" volume={0.18} />
      ))}
      {pops.map((p) => (
        <Sfx key={`p${p}`} at={p} src="pop" volume={0.32} />
      ))}
      {sfxClicks.map((c) => (
        <Sfx key={`c${c}`} at={c} src="click" volume={0.22} />
      ))}
    </AbsoluteFill>
  );
}
