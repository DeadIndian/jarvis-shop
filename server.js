import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { stt, tts, sarvamEnabled } from "./src/sarvam.js";
import { createQr, verifyPaid, isMock } from "./src/pay.js";
import { orders, menu, soldOut, priceCart, createOrder, markPaid, markOrderReady, markLine, allocateDish, parseKitchen, cancelOrder, deliver, setSoldOut, flush, findDish } from "./src/orders.js";
import { schedule, completeTask, setOnline, freeChef, setKitchen, kitchenView, chefsView } from "./src/kitchen.js";
import { hooks } from "./src/orders.js";
import { parse, applyToCart } from "./src/parser.js";
import { say, replyLang } from "./src/phrases.js";

const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Allow-Methods": "GET,POST,OPTIONS" };
const json = (res, code, obj) => { res.writeHead(code, { "Content-Type": "application/json", ...CORS }); res.end(JSON.stringify(obj)); };
const body = (req) => new Promise((ok) => { const c = []; req.on("data", (d) => c.push(d)); req.on("end", () => ok(Buffer.concat(c))); });
const speak = async (text, lang) => { if (!sarvamEnabled()) return null; try { return await tts(text, replyLang(lang)); } catch (e) { console.warn(e.message); return null; } };
const KITCHEN_LANG = process.env.KITCHEN_LANG || "en-IN";
const clients = new Set();
const emit = (type, data = {}) => { const m = `data: ${JSON.stringify({ type, ...data })}\n\n`; for (const c of clients) c.write(m); };
setInterval(() => { for (const c of clients) c.write(": ping\n\n"); }, 20000).unref();
// Counter speaker announces "order N is ready" in the customer's language whenever an order completes (from any path).
hooks.ready = (o) => emit("ready", { number: o.number, lang: o.lang, text: say(o.lang).ready(o.number) });
// Run the scheduler and speak each new task on that chef's own device (SSE event addressed by chefId).
const taskText = (a) => a.whole ? say(a.lang).newOrder(a.number, a.items.map((i) => `${i.qty} ${i.name}`).join(", ")) : say(a.lang).task(a.items[0].qty, a.items[0].name, a.number);
function dispatch() { const out = schedule(); for (const a of out) emit("task", { chefId: a.chefId, number: a.number, lang: a.lang, text: taskText(a) }); emit("update"); return out; }
const menuView = () => ({ ...menu, items: menu.items.map((i) => ({ ...i, soldOut: soldOut.has(i.id) })) });
const view = (o) => ({ id: o.id, number: o.number, lines: o.lines, total: o.total, status: o.status, paidAt: o.paidAt, lang: o.lang });

http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  if (req.method === "OPTIONS") { res.writeHead(204, CORS); return res.end(); }
  try {
    if (url.pathname === "/api/health") return json(res, 200, { ok: true });
    if (url.pathname === "/api/config") return json(res, 200, { menu: menuView(), sarvam: sarvamEnabled(), mock: isMock(), parser: process.env.PARSER || (process.env.LLAMA_URL ? "llama" : process.env.OLLAMA_URL ? "ollama" : "rules") });

    // One customer turn: audio(wav b64) | text -> updated cart + spoken reply
    if (req.method === "POST" && url.pathname === "/api/turn") {
      const { text: typed, audio, cart = [], lang: hint } = JSON.parse((await body(req)).toString());
      const t = {}; let text = typed || "", lang = hint || "en-IN";
      if (audio) { const s = Date.now(); const r = await stt(Buffer.from(audio, "base64")); text = r.text; lang = r.lang || lang; t.stt = Date.now() - s; }
      const P = say(lang);
      const reply = async (msg, extra = {}) => { const s = Date.now(); const a = await speak(msg, lang); t.tts = Date.now() - s; return json(res, 200, { heard: text, reply: msg, lang, cart, ...pricedView(cart), audio: a, timings: t, ...extra }); };
      if (!text) return reply(P.unknown);
      const p = await parse(text); t.parse = p.ms;
      const blocked = Object.keys(p.items).filter((id) => soldOut.has(id)); const blockedNames = blocked.map((id) => menu.items.find((i) => i.id === id).name); blocked.forEach((id) => delete p.items[id]);
      const next = applyToCart(cart, p); const changed = Object.keys(p.items).length || Object.keys(p.remove).length;
      Object.assign(t, { via: p.via });
      if (p.clear) return json(res, 200, { ...(await (async () => { const a = await speak(P.cleared, lang); return { heard: text, reply: P.cleared, lang, cart: [], lines: [], total: 0, action: "clear", audio: a, timings: t }; })()) });
      const pv = pricedView(next);
      if (p.checkout) {
        if (!pv.lines.length) { cart.length = 0; return reply(P.empty); }
        const msg = P.pay(pv.total); const s = Date.now(); const a = await speak(msg, lang); t.tts = Date.now() - s;
        return json(res, 200, { heard: text, reply: msg, lang, cart: next, ...pv, action: "checkout", audio: a, timings: t });
      }
      if (!changed) return reply(blocked.length ? P.soldout(blockedNames.join(", ")) : P.unknown);
      const msg = (blocked.length ? P.soldout(blockedNames.join(", ")) + " " : "") + P.added(pv.lines.map((l) => `${l.qty} ${l.name}`).join(", "), pv.total); const s = Date.now(); const a = await speak(msg, lang); t.tts = Date.now() - s;
      return json(res, 200, { heard: text, reply: msg, lang, cart: next, ...pv, action: "none", audio: a, timings: t });
    }

    if (req.method === "POST" && url.pathname === "/api/checkout") {
      const { cart, lang } = JSON.parse((await body(req)).toString());
      let o; try { o = createOrder(cart, replyLang(lang)); } catch (e) { return json(res, 409, { error: e.message }); }
      return json(res, 200, { order: view(o), qr: await createQr(o) });
    }

    let m;
    if (req.method === "GET" && (m = url.pathname.match(/^\/api\/order\/(ORD\d+)$/))) {
      const o = orders.find((x) => x.id === m[1]); if (!o) return json(res, 404, { error: "no such order" });
      let announce = null;
      if (o.status === "awaiting_payment" && (await verifyPaid(o))) { markPaid(o); dispatch(); emit("order", { order: view(o), text: say(KITCHEN_LANG).newOrder(o.number, o.lines.map((l) => `${l.qty} ${l.name}`).join(", ")) }); const msg = say(o.lang).paid(o.number); announce = { text: msg, audio: await speak(msg, o.lang) }; }
      return json(res, 200, { order: view(o), announce });
    }
    if (req.method === "POST" && (m = url.pathname.match(/^\/api\/order\/(ORD\d+)\/mock-pay$/))) {
      if (!isMock()) return json(res, 403, { error: "mock pay disabled" });
      const o = orders.find((x) => x.id === m[1]); if (o) o.mockPaid = true; return json(res, 200, { ok: !!o });
    }

    if (req.method === "GET" && url.pathname === "/api/kitchen") return json(res, 200, { orders: orders.filter((o) => ["cooking", "ready"].includes(o.status)).sort((a, b) => a.paidAt - b.paidAt).map(view), ...kitchenView() });

    // Chef marks things ready: tap (number [+ lineId]) or voice ("order 104 ready", "dosa ready", "5 dosa ready").
    // Dishes are allocated FIFO to the oldest PAID orders; an order is announced (in its customer's language) once ALL its items are done.
    if (req.method === "POST" && url.pathname === "/api/ready") {
      const { audio, text: typed, dish, number, lineId, qty } = JSON.parse((await body(req)).toString());
      let heard = typed || "", results = [];
      if (number && lineId) { const r = markLine(number, lineId, qty); if (r) results.push(r); }
      else if (number) { const r = markOrderReady(number); if (r) results.push(r); }
      else {
        if (audio) heard = (await stt(Buffer.from(audio, "base64"))).text;
        const k = parseKitchen(heard); if (dish) k.dishes.push({ id: dish, qty: null });
        if (k.numbers.length) k.numbers.forEach((n) => { const r = markOrderReady(n); if (r) results.push(r); });
        else k.dishes.forEach((d) => results.push(...allocateDish(d.id, d.qty)));
      }
      if (!results.length) return json(res, 200, { heard, results: [], announcements: [] });
      dispatch();
      const announcements = results.filter((x) => x.completed).map((r) => ({ number: r.order.number, lang: r.order.lang, text: say(r.order.lang).ready(r.order.number) }));
      return json(res, 200, { heard, results: results.map((r) => ({ number: r.order.number, status: r.order.status, completed: r.completed })), announcements });
    }
    if (req.method === "POST" && (m = url.pathname.match(/^\/api\/order\/(ORD\d+)\/cancel$/))) {
      const o = orders.find((x) => x.id === m[1]); if (!o) return json(res, 404, { error: "no such order" });
      if (o.status === "awaiting_payment" && (await verifyPaid(o))) { markPaid(o); dispatch(); emit("order", { order: view(o), text: say(KITCHEN_LANG).newOrder(o.number, o.lines.map((l) => `${l.qty} ${l.name}`).join(", ")) }); return json(res, 409, { error: "already paid", order: view(o) }); }
      return json(res, cancelOrder(o.id) ? 200 : 409, { ok: o.status === "cancelled", status: o.status });
    }
    if (req.method === "POST" && url.pathname === "/api/deliver") { const { number } = JSON.parse((await body(req)).toString()); const ok = !!deliver(number); if (ok) dispatch(); return json(res, 200, { delivered: ok }); }

    if (url.pathname === "/api/events") { res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", ...CORS }); res.write("retry: 2000\n\n"); clients.add(res); req.on("close", () => clients.delete(res)); return; }
    if (req.method === "POST" && url.pathname === "/api/soldout") { const { id, soldOut: v } = JSON.parse((await body(req)).toString()); const ok = setSoldOut(id, !!v); if (ok) emit("menu"); return json(res, ok ? 200 : 400, { ok }); }
    if (req.method === "POST" && url.pathname === "/api/tts") { const { text, lang } = JSON.parse((await body(req)).toString()); return json(res, 200, { audio: await speak(String(text || "").slice(0, 300), lang || KITCHEN_LANG) }); }

    // ---- kitchen setup + chef devices
    if (url.pathname === "/api/kitchen/config") { if (req.method === "POST") { const v = setKitchen(JSON.parse((await body(req)).toString())); dispatch(); return json(res, 200, v); } return json(res, 200, kitchenView()); }
    if (req.method === "POST" && (m = url.pathname.match(/^\/api\/chefs\/([\w-]+)\/(online|complete|free)$/))) {
      const [, id, act] = m; const b = JSON.parse((await body(req)).toString() || "{}");
      if (act === "online") { if (!setOnline(id, b.online !== false)) return json(res, 404, { error: "no such chef" }); dispatch(); return json(res, 200, { chefs: chefsView() }); }
      if (act === "free") { if (!freeChef(id)) return json(res, 404, { error: "no such chef" }); dispatch(); return json(res, 200, { chefs: chefsView() }); }
      let heard = b.text || ""; if (b.audio) heard = (await stt(Buffer.from(b.audio, "base64"))).text;   // chef can say "done"
      if ((b.audio || b.text != null) && !/\b(done|finish(ed)?|ready|complete(d)?|over)\b/i.test(heard)) return json(res, 200, { heard, completed: false, reason: "not a done phrase" });
      const r = completeTask(id); if (!r) return json(res, 200, { heard, completed: false, reason: "no active task" });
      dispatch(); return json(res, 200, { heard, completed: true, order: view(r.order), orderReady: r.completed });
    }

    // Owner's daily summary (numbers from the order log; text now, LLM-written + multilingual next)
    if (url.pathname === "/api/summary") {
      const paid = orders.filter((o) => o.paidAt); const rev = paid.reduce((s, o) => s + o.total, 0);
      const tally = {}; paid.forEach((o) => o.lines.forEach((l) => (tally[l.name] = (tally[l.name] || 0) + l.qty)));
      const top = Object.entries(tally).sort((a, b) => b[1] - a[1]).slice(0, 3);
      const waits = paid.filter((o) => o.deliveredAt).map((o) => (o.deliveredAt - o.paidAt) / 60000);
      const hours = {}; paid.forEach((o) => { const h = new Date(o.paidAt).getHours(); hours[h] = (hours[h] || 0) + 1; });
      const peak = Object.entries(hours).sort((a, b) => b[1] - a[1])[0];
      const text = paid.length ? `Today you served ${paid.length} orders and earned ${rev} rupees. Top items: ${top.map(([n, q]) => `${n} (${q})`).join(", ")}.${waits.length ? ` Average wait after payment was ${(waits.reduce((a, b) => a + b, 0) / waits.length).toFixed(1)} minutes.` : ""}${peak ? ` Busiest hour: ${peak[0]}:00.` : ""}` : "No paid orders yet today.";
      return json(res, 200, { text, stats: { orders: paid.length, revenue: rev, top, peakHour: peak?.[0] ?? null }, audio: await speak(text, "en-IN") });
    }

    const path = url.pathname === "/" ? "/index.html" : ["/counter", "/kitchen", "/owner"].includes(url.pathname) ? url.pathname + ".html" : url.pathname;
    if (path.includes("..")) return json(res, 400, {});
    const buf = await readFile(new URL("./public" + path, import.meta.url));
    res.writeHead(200, { "Content-Type": types[extname(path)] || "application/octet-stream" }); res.end(buf);
  } catch (e) {
    if (e.code === "ENOENT") return json(res, 404, { error: "not found" });
    console.error(e); json(res, 500, { error: e.message });
  }
}).listen(process.env.PORT || 3000, "0.0.0.0", () => console.log(`Jarvis for Shops on :${process.env.PORT || 3000}  sarvam=${sarvamEnabled()}  parser=${process.env.PARSER || (process.env.LLAMA_URL ? "llama" : process.env.OLLAMA_URL ? "ollama" : "rules")}`));

function pricedView(cart) { const p = priceCart(cart); return { lines: p.lines, total: p.total }; }

for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { flush(); process.exit(0); });
