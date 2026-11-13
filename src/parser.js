// Order parser. Input: English-ish text (from STT translate mode) -> {items, remove, checkout, clear}.
// Providers (PARSER env): llama (Sarvam 30B on llama-server) | ollama (e.g. qwen3.8:27b) | sarvam (cloud) | rules.
// Any provider error falls back to rules, so the counter never stops working.
import { menu } from "./orders.js";
import { chat, sarvamEnabled } from "./sarvam.js";

const MENU = () => menu.items.map((i) => `- ${i.id}: ${i.name} (also called: ${i.aliases.join(", ")})`).join("\n");
const SYS = () => `You are a canteen order parser. Map what the customer says to these menu items ONLY:
${MENU()}
The customer may speak English, Hindi, Telugu, or a mix. Items may appear in their own script. Apply self-corrections ("no, make it four" replaces the earlier number). Set checkout=true only if the customer says they are finished or asks for the bill/payment. Use remove for "remove/cancel one X", clear=true for "cancel everything".
Output ONLY one line of compact JSON: {"items":{"<id>":<qty>},"remove":{"<id>":<qty>},"checkout":false,"clear":false}
Examples:
"one samosa and a tea" -> {"items":{"samosa":1,"chai":1},"remove":{},"checkout":false,"clear":false}
"दो बर्गर, बस इतना ही" -> {"items":{"veg_burger":2},"remove":{},"checkout":true,"clear":false}
"remove the samosa" -> {"items":{},"remove":{"samosa":1},"checkout":false,"clear":false}`;

const clean = (g) => ({
  items: pick(g.items), remove: pick(g.remove), checkout: g.checkout === true, clear: g.clear === true,
});
const ids = new Set(menu.items.map((i) => i.id));
function pick(o) { const out = {}; for (const [k, v] of Object.entries(o || {})) if (ids.has(k) && Number(v) > 0) out[k] = Math.min(20, Math.floor(Number(v))); return out; }
const extract = (s) => clean(JSON.parse(s.match(/\{[\s\S]*\}/)[0]));

const providers = {
  async llama(text) { // Sarvam chat template, thinking disabled via prefilled empty think block (the chat endpoint ignores nothink)
    const p = `<|start_of_turn|><|system|>\n${SYS()}<|end_of_turn|>\n<|start_of_turn|><|user|>\n${text}<|nothink|><|end_of_turn|>\n<|start_of_turn|><|assistant|>\n<think></think>\n`;
    const h = { "Content-Type": "application/json" }; if (process.env.LLAMA_KEY) h.Authorization = "Bearer " + process.env.LLAMA_KEY;
    const r = await fetch(process.env.LLAMA_URL + "/completion", { method: "POST", headers: h, body: JSON.stringify({ prompt: p, n_predict: 100, temperature: 0, stop: ["<|end_of_turn|>", "\n\n"] }), signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error("llama " + r.status);
    return extract((await r.json()).content);
  },
  async ollama(text) {
    const r = await fetch((process.env.OLLAMA_URL || "http://localhost:11434") + "/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(15000),
      body: JSON.stringify({ model: process.env.OLLAMA_MODEL || "qwen3.8:27b", stream: false, think: false, keep_alive: "10m", options: { temperature: 0, num_predict: 100 }, messages: [{ role: "system", content: SYS() }, { role: "user", content: text }] }) });
    if (!r.ok) throw new Error("ollama " + r.status);
    return extract((await r.json()).message.content);
  },
  async sarvam(text) { return extract(await chat([{ role: "system", content: SYS() }, { role: "user", content: text }])); },
  async rules(text) {
    const t = text.toLowerCase(), words = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, ek: 1, do: 2, teen: 3 };
    const items = {};
    for (const m of menu.items) for (const a of [m.name, ...m.aliases]) {
      const i = t.indexOf(a.toLowerCase()); if (i < 0) continue;
      const q = t.slice(Math.max(0, i - 14), i).match(/(\d+|one|two|three|four|five|six|ek|do|teen|an?)\s*$/);
      items[m.id] = (items[m.id] || 0) + (q ? parseInt(q[1]) || words[q[1]] || 1 : 1); break;
    }
    const removing = /\b(remove|cancel|delete|take out|without)\b/.test(t) && Object.keys(items).length > 0;
    return { items: removing ? {} : items, remove: removing ? items : {}, checkout: !removing && /\b(pay|bill|that's all|done|bas|checkout)\b/.test(t), clear: /\b(cancel (everything|all|order)|clear|reset)\b/.test(t) };
  },
};
function primary() { return process.env.PARSER || (process.env.LLAMA_URL ? "llama" : process.env.OLLAMA_URL ? "ollama" : "rules"); }

export async function parse(text) {
  const name = primary(); const t0 = Date.now();
  try { const r = await providers[name](text); return { ...r, via: name, ms: Date.now() - t0 }; }
  catch (e) { console.warn(`parser ${name} failed (${e.message}); using rules`); const r = await providers.rules(text); return { ...r, via: "rules(fallback)", ms: Date.now() - t0 }; }
}

export function applyToCart(cart, p) {
  if (p.clear) return [];
  const m = new Map(cart.map((c) => [c.id, c.qty]));
  for (const [id, q] of Object.entries(p.items)) m.set(id, (m.get(id) || 0) + q);
  for (const [id, q] of Object.entries(p.remove)) { const n = (m.get(id) || 0) - q; n > 0 ? m.set(id, n) : m.delete(id); }
  return [...m].map(([id, qty]) => ({ id, qty }));
}
