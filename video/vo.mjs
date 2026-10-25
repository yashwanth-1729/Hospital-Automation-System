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
// General pitch for any doctor or hospital owner. "H.M.S." is spelled out so it is read as letters.
export const SCRIPT = `[calm, measured] Every hospital works hard to treat its patients. But between visits... patients quietly slip away. A missed call. A follow-up nobody made. A report nobody chased.

[warm, confident] Clevo fixes that. It's an A.I. layer that plugs into the H.M.S. you already use... and handles patient follow-up on WhatsApp, automatically.

[clear, upbeat] When a patient enquires, Clevo replies in seconds... books the appointment... and sends the reminders, so fewer patients miss their visit.

[steady, assured] Between visits, it keeps care on track. Diabetic and blood pressure patients are reminded before every review. Lab reports reach patients the moment they're ready. And when someone misses an appointment, Clevo offers the next open slot... and brings them back.

[serious, reassuring] Anything that needs a person goes straight to the doctor, or your front desk. Nothing falls through the cracks.

[confident] No H.M.S. yet? Clevo can run the whole clinic. Reception, consultation, pharmacy and billing... with allergy checks, and bills that build themselves.

[warm, lighter] And for you, every morning, a sixty-second summary of your hospital... and an assistant you can simply ask.

[sincere, inspiring] Clevo is built, and live today. Let's set it up for your hospital... and let the results speak.`;

async function take(name, n) {
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${VOICES[name]}/with-timestamps?output_format=mp3_44100_128`, {
    method: "POST",
    headers: { "xi-api-key": KEY, "content-type": "application/json" },
    body: JSON.stringify({ text: SCRIPT, model_id: "eleven_v4", voice_settings: { speed: 1.0 } }),
  });
  if (!res.ok) throw new Error(`${name}: ${res.status} ${await res.text()}`);
  const data = await res.json();
  const file = `public/vo/${process.env.TAG ?? "v3"}-${name}-${n}`;
  writeFileSync(`${file}.mp3`, Buffer.from(data.audio_base64, "base64"));
  writeFileSync(`${file}.json`, JSON.stringify(data.normalized_alignment ?? data.alignment));
  const a = data.alignment;
  console.log(`${file}.mp3  ${a.character_end_times_seconds.at(-1).toFixed(1)}s`);
}

mkdirSync("public/vo", { recursive: true });
const [voice, count] = process.argv.slice(2);
const names = voice ? [voice] : Object.keys(VOICES);
for (const name of names) for (let i = 1; i <= Number(count || 1); i++) await take(name, i);
