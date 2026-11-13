// Sarvam cloud: speech only (STT/TTS). One STT call per turn; TTS results are cached by (lang,text).
const BASE = "https://api.sarvam.ai";
const key = () => process.env.SARVAM_API_KEY;
export const sarvamEnabled = () => !!key();
export const TTS_LANGS = new Set(["en-IN", "hi-IN", "bn-IN", "gu-IN", "kn-IN", "mr-IN", "pa-IN", "ta-IN", "te-IN"]);

// mode "translate" => English text (what the parser wants) + detected source language in one call.
export async function stt(wavBuffer, mode = "translate") {
  const fd = new FormData();
  fd.append("file", new Blob([wavBuffer], { type: "audio/wav" }), "speech.wav");
  fd.append("model", "saaras:v4"); fd.append("mode", mode);
  const r = await fetch(`${BASE}/speech-to-text`, { method: "POST", headers: { "api-subscription-key": key() }, body: fd });
  if (!r.ok) throw new Error(`STT ${r.status}: ${await r.text()}`);
  const j = await r.json();
  return { text: (j.transcript || "").trim(), lang: j.language_code || null };
}

const cache = new Map();
export async function tts(text, lang = "en-IN") {
  if (!TTS_LANGS.has(lang)) lang = "en-IN";
  const k = lang + "|" + text; if (cache.has(k)) return cache.get(k);
  const body = { text: text.slice(0, 900), language_code: lang, model: "bulbul:v4-flash" };
  if (process.env.TTS_SPEAKER) body.speaker = process.env.TTS_SPEAKER;
  const r = await fetch(`${BASE}/text-to-speech`, { method: "POST", headers: { "api-subscription-key": key(), "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`TTS ${r.status}: ${await r.text()}`);
  const a = ((await r.json()).audios || []).join("");
  if (cache.size > 300) cache.delete(cache.keys().next().value);
  cache.set(k, a); return a;
}

export async function chat(messages) { // optional cloud parser
  const r = await fetch(`${BASE}/v1/chat/completions`, { method: "POST", headers: { "api-subscription-key": key(), "Content-Type": "application/json" }, body: JSON.stringify({ model: "sarvam-105b", messages, temperature: 0 }) });
  if (!r.ok) throw new Error(`Chat ${r.status}: ${await r.text()}`);
  return ((await r.json()).choices?.[0]?.message?.content || "").replace(/<think>[\s\S]*?<\/think>/g, "").trim();
}
