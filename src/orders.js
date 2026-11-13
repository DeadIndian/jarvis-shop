// Order state machine + FIFO pickup matching, persisted to data/state.json (atomic write).
import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
export const menu = JSON.parse(readFileSync(new URL("../menu.json", import.meta.url)));
const byId = Object.fromEntries(menu.items.map((i) => [i.id, i]));
const DATA = process.env.DATA_DIR || fileURLToPath(new URL("../data/", import.meta.url));
const FILE = join(DATA, "state.json");

export const orders = [];
export const soldOut = new Set();
export const kitchenState = { mode: "station", chefs: [] };   // chefs: {id,name,lang,skills[],online,task:{number,lineIds,since}|null}
export const hooks = { ready: null };                           // called when an order becomes fully ready
let seq = 100;
try { const j = JSON.parse(readFileSync(FILE, "utf8")); orders.push(...j.orders); j.soldOut.forEach((x) => soldOut.add(x)); if (j.kitchen) Object.assign(kitchenState, j.kitchen); seq = Math.max(100, ...orders.map((o) => o.number)); } catch {}

let timer = null;
export function flush() { clearTimeout(timer); mkdirSync(DATA, { recursive: true }); const tmp = FILE + ".tmp"; writeFileSync(tmp, JSON.stringify({ orders, soldOut: [...soldOut], kitchen: kitchenState })); renameSync(tmp, FILE); }
export const persist = () => { clearTimeout(timer); timer = setTimeout(flush, 150); };

export function priceCart(rawItems) {
  const lines = [];
  for (const it of rawItems || []) {
    const m = byId[it.id]; const qty = Math.max(1, Math.min(20, parseInt(it.qty) || 1));
    if (m) lines.push({ id: m.id, name: m.name, qty, price: m.price });
  }
  return { lines, total: lines.reduce((s, l) => s + l.qty * l.price, 0) };
}

export function createOrder(cart, lang = "en-IN") {
  const { lines, total } = priceCart(cart);
  if (!lines.length) throw new Error("empty cart");
  const gone = lines.filter((l) => soldOut.has(l.id)).map((l) => l.name);
  if (gone.length) throw new Error("sold out: " + gone.join(", "));
  const o = { id: `ORD${++seq}`, number: seq, lines, total, lang, status: "awaiting_payment", createdAt: Date.now(), paidAt: null, readyAt: null, deliveredAt: null };
  orders.push(o); persist(); return o;
}
export function markPaid(o) { if (o.status === "awaiting_payment") { o.status = "cooking"; o.paidAt = Date.now(); persist(); } return o; }

// ---- Kitchen readiness. Each line tracks `done` (qty ready); an order is "ready" when every line is done.
const need = (l) => l.qty - (l.done || 0);
const cooking = () => orders.filter((o) => o.status === "cooking").sort((a, b) => a.paidAt - b.paidAt);
export function finish(o) { if (o.status === "cooking" && o.lines.every((l) => need(l) <= 0)) { o.status = "ready"; o.readyAt = Date.now(); hooks.ready?.(o); return true; } return false; }
// whole order ready ("order 104 ready" / Order ready button)
export function markOrderReady(number) { const o = cooking().find((x) => x.number === number); if (!o) return null; o.lines.forEach((l) => (l.done = l.qty)); finish(o); persist(); return { order: o, completed: true }; }
// one line of one order (tap a dish on the card); qty defaults to everything still outstanding on that line
export function markLine(number, lineId, qty) { const o = cooking().find((x) => x.number === number); const l = o?.lines.find((x) => x.id === lineId); if (!l || need(l) <= 0) return null; l.done = (l.done || 0) + Math.min(need(l), qty > 0 ? qty : need(l)); const completed = finish(o); persist(); return { order: o, completed }; }
// "dosa ready" / "5 dosa ready": give the dish to the OLDEST paid orders that still need it, FIFO. No qty = oldest order's need only.
export function allocateDish(dishId, qty = null) {
  const out = []; let left = qty;
  for (const o of cooking()) {
    const l = o.lines.find((x) => x.id === dishId && need(x) > 0); if (!l) continue;
    const give = left == null ? need(l) : Math.min(need(l), left); l.done = (l.done || 0) + give;
    out.push({ order: o, completed: finish(o), dish: dishId, given: give });
    if (left == null) break; left -= give; if (left <= 0) break;
  }
  if (out.length) persist(); return out;
}
const WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
// chef speech (English via STT translate) -> order numbers mentioned + dishes (with optional qty)
export function parseKitchen(text) {
  const t = (text || "").toLowerCase();
  const numbers = [...t.matchAll(/\b(\d{3,5})\b/g)].map((m) => +m[1]).filter((n) => orders.some((o) => o.number === n));
  const dishes = [];
  for (const m of menu.items) for (const a of [m.name, ...m.aliases]) {
    const i = t.indexOf(a.toLowerCase()); if (i < 0) continue;
    const q = t.slice(Math.max(0, i - 12), i).match(/(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten)\s*$/);
    dishes.push({ id: m.id, qty: q ? parseInt(q[1]) || WORDS[q[1]] : null }); break;
  }
  return { numbers, dishes };
}
export function cancelOrder(id) { const o = orders.find((x) => x.id === id); if (!o || o.status !== "awaiting_payment") return null; o.status = "cancelled"; persist(); return o; }
export function deliver(num) { const o = orders.find((x) => x.number === num && x.status === "ready"); if (o) { o.status = "delivered"; o.deliveredAt = Date.now(); persist(); } return o || null; }
export function setSoldOut(id, v) { if (!byId[id]) return false; v ? soldOut.add(id) : soldOut.delete(id); persist(); return true; }
export function findDish(text) {
  const t = (text || "").toLowerCase();
  for (const m of menu.items) if ([m.name, ...m.aliases].some((a) => t.includes(a.toLowerCase()))) return m.id;
  return null;
}
