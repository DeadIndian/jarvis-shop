// Usage: node scripts/seed-demo.mjs [canteen|restaurant|kirana]
// Writes two weeks of realistic canteen orders to demo-data/state.json (NOT the real data dir), so the Owner screens have
// something to show. Deterministic. Run: npm run demo   (seeds, then starts the server on that data)
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
const shop = process.argv[2] || "canteen", prof = JSON.parse(readFileSync(new URL(`../profiles/${shop}.json`, import.meta.url))), menu = prof.items;
let seed = 42; const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
const pick = (w) => { let r = rnd() * w.reduce((a, b) => a + b[1], 0); for (const [v, x] of w) if ((r -= x) <= 0) return v; return w[0][0]; };
const weight = Object.fromEntries(menu.map((m) => [m.id, m.pop || 10]));
const after = prof.payWhen === "after", qtyFor = (m) => (m.step < 1 ? [0.5, 0.5, 1, 1, 1.5, 2][Math.floor(rnd() * 6)] : 1 + (rnd() < 0.3 ? 1 : 0));
const hourW = [[8, 4], [9, 9], [10, 6], [11, 10], [12, 18], [13, 22], [14, 12], [15, 7], [16, 16], [17, 12], [18, 5]];   // lunch + tea-time rush
const DAY = 86400000, now = Date.now(), t0 = new Date(now).setHours(0, 0, 0, 0);
const orders = []; let n = 100;
for (let d = 13; d >= 0; d--) {
  const day = t0 - d * DAY, dow = new Date(day).getDay(), base = dow === 0 ? 22 : dow === 6 ? 32 : 55 + Math.floor(rnd() * 15);
  const lim = d === 0 ? now : day + DAY;
  const days = [];
  for (let i = 0; i < base; i++) {
    const h = pick(hourW), paidAt = day + h * 3600000 + Math.floor(rnd() * 3600000); if (paidAt > lim) continue;
    const lines = []; const k = 1 + Math.floor(rnd() * 3);
    for (let j = 0; j < k; j++) { const id = pick(Object.entries(weight)); const m = menu.find((x) => x.id === id); if (!lines.some((l) => l.id === id)) { const qty = qtyFor(m); lines.push({ id, name: m.name, qty, unit: m.unit, price: m.price, amount: Math.round(qty * m.price) }); } }
    const busy = [12, 13, 16].includes(h), wait = (busy ? 6 + rnd() * 6 : 2.5 + rnd() * 3) * 60000;
    const readyAt = paidAt + wait, deliveredAt = readyAt + (1 + rnd() * 2) * 60000;
    days.push({ lines, paidAt, readyAt: Math.min(readyAt, lim), deliveredAt: Math.min(deliveredAt, lim), done: readyAt < lim });
  }
  days.sort((a, b) => a.paidAt - b.paidAt).forEach((o) => orders.push({ id: `ORD${++n}`, number: n, lines: o.lines.map((l) => ({ ...l, done: o.done ? l.qty : 0 })), total: o.lines.reduce((s, l) => s + l.amount, 0), shop, lang: ["en-IN", "hi-IN", "te-IN"][Math.floor(rnd() * 3)],
    status: o.done ? "delivered" : "cooking", createdAt: o.paidAt - 40000, startedAt: o.paidAt, paidAt: o.done || !after ? (after ? o.deliveredAt : o.paidAt) : null, method: after ? (rnd() < 0.6 ? "cash" : "upi") : undefined, readyAt: o.done ? o.readyAt : null, deliveredAt: o.done ? o.deliveredAt : null }));
}
const out = shop === "canteen" ? "demo-data" : "demo-" + shop; mkdirSync(new URL(`../${out}/`, import.meta.url), { recursive: true });
writeFileSync(new URL(`../${out}/state.json`, import.meta.url), JSON.stringify({ orders, soldOut: shop === "canteen" ? ["cold_coffee"] : [], kitchen: { mode: prof.fulfil === "pack" ? "order" : "station", chefs: [] }, shop }));
console.log(`${out}/state.json: ${orders.length} orders over 14 days`);
