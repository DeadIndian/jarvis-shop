// Small general-purpose LLM call for the owner copilot. Same providers as the order parser; throws if none is reachable
// (the caller then falls back to the rules answerer).
import { chat, sarvamEnabled } from "./sarvam.js";
import { llmGate } from "./limiter.js";
import { allowed, track } from "./usage.js";
const clean = (s) => (s || "").replace(/<think>[\s\S]*?<\/think>/g, "").replace(/\*\*|__|`|^#+\s*/gm, "").replace(/\s+\n/g, "\n").trim();
export const llmProvider = () => process.env.COPILOT_LLM || (process.env.LLAMA_URL ? "llama" : process.env.OLLAMA_URL ? "ollama" : sarvamEnabled() ? "sarvam" : null);

export async function ask(system, user, maxTokens = 260) {
  if (!allowed("llm")) throw new Error("daily model limit reached");
  const out = await llmGate(() => askRaw(system, user, maxTokens)); track("llm"); return out;
}
async function askRaw(system, user, maxTokens) {
  const p = llmProvider(); if (!p) throw new Error("no LLM configured");
  if (p === "llama") {   // Sarvam 30B: raw completion with an empty think block (the chat endpoint always thinks)
    const prompt = `<|start_of_turn|><|system|>\n${system}<|end_of_turn|>\n<|start_of_turn|><|user|>\n${user}<|nothink|><|end_of_turn|>\n<|start_of_turn|><|assistant|>\n<think></think>\n`;
    const h = { "Content-Type": "application/json" }; if (process.env.LLAMA_KEY) h.Authorization = "Bearer " + process.env.LLAMA_KEY;
    const r = await fetch(process.env.LLAMA_URL + "/completion", { method: "POST", headers: h, signal: AbortSignal.timeout(+process.env.LLM_TIMEOUT_MS || 12000), body: JSON.stringify({ prompt, n_predict: maxTokens, temperature: 0.2, stop: ["<|end_of_turn|>"] }) });
    if (!r.ok) throw new Error("llama " + r.status); return clean((await r.json()).content);
  }
  if (p === "ollama") {
    const r = await fetch((process.env.OLLAMA_URL || "http://localhost:11434") + "/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(30000),
      body: JSON.stringify({ model: process.env.OLLAMA_MODEL || "qwen3.8:27b", stream: false, think: false, keep_alive: "10m", options: { temperature: 0.2, num_predict: maxTokens }, messages: [{ role: "system", content: system }, { role: "user", content: user }] }) });
    if (!r.ok) throw new Error("ollama " + r.status); return clean((await r.json()).message.content);
  }
  return clean(await chat([{ role: "system", content: system }, { role: "user", content: user }]));
}
