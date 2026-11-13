// Voice lab: for each language, synthesize canteen orders with Bulbul, then transcribe them back with
// Saaras v4 (transcribe + translate modes). Measures accuracy by eye + latency. Needs SARVAM_API_KEY.
// Run: node --env-file=.env roundtrip.mjs
import { writeFileSync } from "node:fs";
const KEY = process.env.SARVAM_API_KEY; if (!KEY) { console.error("Set SARVAM_API_KEY in .env"); process.exit(1); }
const B = "https://api.sarvam.ai";
const SPEAKER = process.env.TTS_SPEAKER; // optional; omitted -> API default voice

const CASES = [
  { lang: "en-IN", text: "Two masala dosa and one cold coffee please" },
  { lang: "en-IN", text: "Give me three samosa, no, make it four, and a chai" },
  { lang: "hi-IN", text: "मुझे दो मसाला डोसा और एक कोल्ड कॉफी चाहिए" },
  { lang: "hi-IN", text: "bhaiya ek veg burger aur do chai dena, bas bill bana do" },
  { lang: "te-IN", text: "నాకు రెండు మసాలా దోశ మరియు ఒక చాయ్ కావాలి" },
  { lang: "te-IN", text: "ఒక పన్నీర్ రోల్ ఇవ్వండి, ఇంకేమీ వద్దు" },
];
const ms = async (f) => { const t = performance.now(); const r = await f(); return [r, Math.round(performance.now() - t)]; };

async function tts(text, lang) {
  const body = { text, language_code: lang, model: "bulbul:v4-flash" }; if (SPEAKER) body.speaker = SPEAKER;
  const r = await fetch(`${B}/text-to-speech`, { method: "POST", headers: { "api-subscription-key": KEY, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`TTS ${r.status} ${await r.text()}`);
  return Buffer.from((await r.json()).audios.join(""), "base64");
}
async function stt(wav, mode) {
  const fd = new FormData(); fd.append("file", new Blob([wav], { type: "audio/wav" }), "a.wav"); fd.append("model", "saaras:v4"); fd.append("mode", mode);
  const r = await fetch(`${B}/speech-to-text`, { method: "POST", headers: { "api-subscription-key": KEY }, body: fd });
  if (!r.ok) throw new Error(`STT ${r.status} ${await r.text()}`);
  return r.json();
}

for (const [i, c] of CASES.entries()) {
  try {
    const [wav, tTts] = await ms(() => tts(c.text, c.lang)); writeFileSync(`out/${i}-${c.lang}.wav`, wav);
    const [a, t1] = await ms(() => stt(wav, "transcribe"));
    const [b, t2] = await ms(() => stt(wav, "translate"));
    console.log(`\n[${c.lang}] said:       ${c.text}\n  transcribe (${t1}ms, detected ${a.language_code}): ${a.transcript}\n  translate  (${t2}ms): ${b.transcript}\n  tts ${tTts}ms`);
  } catch (e) { console.log(`\n[${c.lang}] FAILED: ${e.message}`); }
}
