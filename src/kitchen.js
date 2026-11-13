// Kitchen scheduler. Chefs are configured (count, language, dishes they own). Each online chef holds ONE task at a time.
//  mode "station": a task = one dish line of one order. Oldest orders first; a chef gets dishes they own first,
//                  and helps with any other dish when nothing of theirs is waiting.
//  mode "order":   a task = a whole order (oldest first, any idle chef).
// Finishing a task frees the chef, and the scheduler immediately hands them the next one.
import { orders, kitchenState as K, persist, finish, menu } from "./orders.js";
const need = (l) => l.qty - (l.done || 0);
const LANGS = new Set(["en-IN", "hi-IN", "te-IN"]);
const dishes = new Set(menu.items.map((i) => i.id));
const cooking = () => orders.filter((o) => o.status === "cooking").sort((a, b) => a.paidAt - b.paidAt);
const find = (id) => K.chefs.find((c) => c.id === id);

export function chefsView() {
  return K.chefs.map((c) => {
    const o = c.task && orders.find((x) => x.number === c.task.number);
    const items = o ? o.lines.filter((l) => c.task.lineIds.includes(l.id)).map((l) => ({ id: l.id, name: l.name, qty: need(l) })) : [];
    return { id: c.id, name: c.name, lang: c.lang, skills: c.skills, online: c.online, task: c.task ? { number: c.task.number, since: c.task.since, items } : null };
  });
}
export const kitchenView = () => ({ mode: K.mode, chefs: chefsView() });

function release(c) {
  if (c.task) { const o = orders.find((x) => x.number === c.task.number); o?.lines.forEach((l) => { if (l.chefId === c.id) l.chefId = null; }); c.task = null; }
}
// drop tasks that finished (or were completed from the board) and stale assignments
export function sync() {
  for (const c of K.chefs) if (c.task) {
    const o = orders.find((x) => x.number === c.task.number); const ls = o ? o.lines.filter((l) => c.task.lineIds.includes(l.id)) : [];
    if (!o || o.status !== "cooking" || ls.every((l) => need(l) <= 0)) { ls.forEach((l) => { if (l.chefId === c.id) l.chefId = null; }); c.task = null; }
  }
  for (const o of orders) for (const l of o.lines) if (l.chefId && !K.chefs.some((c) => c.id === l.chefId && c.task?.number === o.number)) l.chefId = null;
}

// Hand out tasks to idle online chefs. Returns the new assignments so the server can speak them to the right devices.
export function schedule() {
  sync(); const out = [];
  const idle = () => K.chefs.filter((c) => c.online && !c.task);
  const assign = (c, o, ls) => {
    ls.forEach((l) => (l.chefId = c.id)); c.task = { number: o.number, lineIds: ls.map((l) => l.id), since: Date.now() };
    out.push({ chefId: c.id, name: c.name, lang: c.lang, number: o.number, whole: K.mode === "order", items: ls.map((l) => ({ id: l.id, name: l.name, qty: need(l) })) });
  };
  if (K.mode === "order") {
    for (const o of cooking()) { const ls = o.lines.filter((l) => need(l) > 0); if (!ls.length || ls.some((l) => l.chefId)) continue; const c = idle()[0]; if (!c) break; assign(c, o, ls); }
  } else {
    const tasks = []; for (const o of cooking()) for (const l of o.lines) if (need(l) > 0 && !l.chefId) tasks.push({ o, l });
    const left = [];
    for (const t of tasks) { const c = idle().find((c) => c.skills.includes(t.l.id)); c ? assign(c, t.o, [t.l]) : left.push(t); }   // chefs who own the dish
    for (const t of left) { const c = idle()[0]; if (!c) break; assign(c, t.o, [t.l]); }                                         // otherwise whoever is free
  }
  if (out.length) persist(); return out;
}

export function completeTask(chefId) {
  const c = find(chefId); if (!c?.task) return null;
  const o = orders.find((x) => x.number === c.task.number); if (!o) { c.task = null; return null; }
  o.lines.filter((l) => c.task.lineIds.includes(l.id)).forEach((l) => { l.done = l.qty; l.chefId = null; });
  c.task = null; const completed = finish(o); persist(); return { order: o, completed };
}
export function setOnline(chefId, on) { const c = find(chefId); if (!c) return false; c.online = !!on; if (!on) release(c); persist(); return true; }
export function freeChef(chefId) { const c = find(chefId); if (!c) return false; release(c); persist(); return true; }   // manager "reassign"

export function setKitchen({ mode, chefs }) {
  if ((mode === "station" || mode === "order") && mode !== K.mode) { K.chefs.forEach(release); K.mode = mode; }
  if (Array.isArray(chefs)) {
    const next = []; const used = new Set();
    chefs.slice(0, 12).forEach((c, i) => {
      let id = c.id && !used.has(c.id) ? c.id : null; if (!id) { let n = 1; while (used.has("c" + n) || K.chefs.some((x) => x.id === "c" + n && x.id !== c.id)) n++; id = "c" + n; }
      used.add(id); const old = find(id);
      next.push({ id, name: String(c.name || `Chef ${i + 1}`).slice(0, 30), lang: LANGS.has(c.lang) ? c.lang : "en-IN", skills: [...new Set((c.skills || []).filter((d) => dishes.has(d)))], online: old?.online || false, task: old?.task || null });
    });
    K.chefs.filter((c) => !used.has(c.id)).forEach(release);
    K.chefs = next;
  }
  persist(); return kitchenView();
}
