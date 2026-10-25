import align from "../public/vo/v3-eric-1.json";

/** Seconds of quiet before the voice starts, and the end card after it. */
export const VO_START = 0.6;
export const OUTRO = 4.6;

type Alignment = { characters: string[]; character_start_times_seconds: number[]; character_end_times_seconds: number[] };
const a = align as Alignment;

// Letters and digits only, so "H.M.S." and punctuation never break a lookup.
let flat = "";
const map: number[] = [];
a.characters.forEach((c, i) => {
  if (/[a-z0-9]/i.test(c)) {
    flat += c.toLowerCase();
    map.push(i);
  }
});

/** Time (in video seconds) at which a phrase starts being spoken. */
export function at(phrase: string, after = 0): number {
  const q = phrase.toLowerCase().replace(/[^a-z0-9]/g, "");
  let from = 0;
  for (;;) {
    const k = flat.indexOf(q, from);
    if (k < 0) throw new Error(`phrase not in voiceover: ${phrase}`);
    const t = a.character_start_times_seconds[map[k]!]! + VO_START;
    if (t >= after) return t;
    from = k + 1;
  }
}

export const VO_END = a.character_end_times_seconds[a.character_end_times_seconds.length - 1]! + VO_START;
export const TOTAL = VO_END + OUTRO;

export interface Word {
  text: string;
  start: number;
  end: number;
}

/** The spoken words with their times, bracketed delivery cues removed. */
export const WORDS: Word[] = (() => {
  const out: Word[] = [];
  let cur = "";
  let start = 0;
  let end = 0;
  let inTag = false;
  a.characters.forEach((c, i) => {
    if (c === "[") inTag = true;
    if (inTag) {
      if (c === "]") inTag = false;
      return;
    }
    if (/\s/.test(c)) {
      if (cur) out.push({ text: cur, start: start + VO_START, end: end + VO_START });
      cur = "";
      return;
    }
    if (!cur) start = a.character_start_times_seconds[i]!;
    cur += c;
    end = a.character_end_times_seconds[i]!;
  });
  if (cur) out.push({ text: cur, start: start + VO_START, end: end + VO_START });
  return out;
})();

/** Scene boundaries, anchored to the words that introduce them. */
export const T = {
  hook: 0,
  missed: at("A missed call"),
  followup: at("A follow-up nobody"),
  report: at("A report nobody"),
  intro: at("Clevo fixes that") - 0.25,
  plugs: at("plugs into"),
  whatsapp: at("on WhatsApp"),
  front: at("When a patient") - 0.3,
  books: at("books the appointment"),
  reminders: at("sends the reminders"),
  between: at("Between visits, it keeps") - 0.3,
  labs: at("Lab reports reach") - 0.2,
  noshow: at("And when someone") - 0.2,
  bringsBack: at("brings them back"),
  safety: at("Anything that needs") - 0.3,
  cracks: at("Nothing falls"),
  full: at("No H") - 0.25,
  modules: at("Reception, consultation"),
  allergy: at("with allergy checks"),
  bills: at("bills that build"),
  owner: at("And for you") - 0.25,
  assistant: at("an assistant"),
  close: at("Clevo is built") - 0.25,
  setUp: at("Let's set it up"),
  end: VO_END,
};
