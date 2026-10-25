// Voiceover with ElevenLabs (Eleven v4), directed with audio tags, plus word timings for captions.
//   node vo.mjs                 one take per voice in VOICES
//   node vo.mjs eric 3          three takes of one voice
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const KEY = readFileSync(".env", "utf8").match(/ELEVENLABS_API_KEY=(\S+)/)[1];
const VOICES = {
  eric: "cjVigY5qzO86Huf0OWal", // smooth, trustworthy
  daniel: "onwK4e9ZLuTAKqWW03F9", // steady broadcaster, British
  brian: "nPczCjzI2devNBz1zQrb", // deep, resonant
};

// One tone cue per passage, as the ElevenLabs guide recommends. Ellipses carry the pauses.
export const SCRIPT = `[calm, serious, measured] Every day... clinics lose patients in the gaps. A missed call. A forgotten booking. A bill that takes too long.

[warm, confident] This is Clevo. One system that runs the whole clinic... and keeps every patient informed, on WhatsApp.

[clear, assured] A patient books online. Within seconds, WhatsApp confirms the appointment. No one typed a word.

[serious, reassuring] The doctor sees the full history. And if a medicine clashes with an allergy... Clevo stops it, before it ever reaches the patient.

[brisk, upbeat] One click at the pharmacy hands over the medicine, and builds the bill. The receipt lands on the patient's phone.

[curious, lighter] And the people who run the clinic? They can simply ask Clevo... and get answers from live data.

[sincere, inspiring] Clevo is live today, built here by a young local team. We're asking for one thing: a pilot in our city's clinics. [warm, proud] Faster, safer care... closer to every patient.`;

async function take(name, n) {
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${VOICES[name]}/with-timestamps?output_format=mp3_44100_128`, {
    method: "POST",
    headers: { "xi-api-key": KEY, "content-type": "application/json" },
    body: JSON.stringify({ text: SCRIPT, model_id: "eleven_v4", voice_settings: { speed: 1.0 } }),
  });
  if (!res.ok) throw new Error(`${name}: ${res.status} ${await res.text()}`);
  const data = await res.json();
  const file = `public/vo/${name}-${n}`;
  writeFileSync(`${file}.mp3`, Buffer.from(data.audio_base64, "base64"));
  writeFileSync(`${file}.json`, JSON.stringify(data.normalized_alignment ?? data.alignment));
  const a = data.alignment;
  console.log(`${file}.mp3  ${a.character_end_times_seconds.at(-1).toFixed(1)}s`);
}

mkdirSync("public/vo", { recursive: true });
const [voice, count] = process.argv.slice(2);
const names = voice ? [voice] : Object.keys(VOICES);
for (const name of names) for (let i = 1; i <= Number(count || 1); i++) await take(name, i);
