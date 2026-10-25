import { loadFont } from "@remotion/google-fonts/PlusJakartaSans";
import { Easing } from "remotion";

export const { fontFamily } = loadFont("normal", { weights: ["400", "500", "600", "700", "800"], subsets: ["latin"] });

export const FPS = 30;
export const W = 1080;
export const H = 1350;

/** One accent on a calm, slightly green-tinted neutral family. Restraint is the look. */
export const C = {
  bg: "#F5F9F6",
  bg2: "#EAF4EE",
  surface: "#FFFFFF",
  ink: "#0B2117",
  ink2: "#2F4A3E",
  muted: "#6B8378",
  line: "#DCE9E1",
  accent: "#059669",
  accentDeep: "#065F46",
  accentSoft: "#DDF4E8",
  glow: "rgba(16,185,129,0.22)",
  warn: "#B45309",
  coral: "#D9534F",
  coralSoft: "#FCEDEC",
};

/** Ease-out-expo: decisive entrances that settle without bounce. */
export const easeOut = Easing.bezier(0.16, 1, 0.3, 1);
export const easeInOut = Easing.bezier(0.65, 0, 0.35, 1);

export const shadow = {
  card: "0 1px 2px rgba(6,60,40,0.06), 0 12px 32px -12px rgba(6,60,40,0.18)",
  float: "0 2px 6px rgba(6,60,40,0.06), 0 40px 90px -30px rgba(6,60,40,0.35)",
};
