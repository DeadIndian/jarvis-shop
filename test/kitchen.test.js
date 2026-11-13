import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path";
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "jarvis-test-"));       // never touch real data
const { createOrder, markPaid, hooks, flush } = await import("../src/orders.js");
const K = await import("../src/kitchen.js");
const ready = []; hooks.ready = (o) => ready.push(o.number);
const pay = (cart, age = 0) => { const o = createOrder(cart); markPaid(o); o.paidAt -= age; return o; };

// --- station mode: A owns dosa, B owns chai+samosa
K.setKitchen({ mode: "station", chefs: [{ name: "A", skills: ["masala_dosa"] }, { name: "B", skills: ["chai", "samosa"] }] });
const [A, B] = K.kitchenView().chefs.map((c) => c.id);
assert.equal(K.schedule().length, 0, "offline chefs get nothing");
const o1 = pay([{ id: "masala_dosa", qty: 2 }, { id: "chai", qty: 1 }], 3000), o2 = pay([{ id: "samosa", qty: 1 }], 1000);
K.setOnline(A, true); K.setOnline(B, true);
let out = K.schedule(); const by = Object.fromEntries(out.map((x) => [x.chefId, x]));
assert.equal(out.length, 2); assert.equal(by[A].items[0].id, "masala_dosa"); assert.equal(by[B].items[0].id, "chai", "specialists get their dishes, oldest order first");
assert.equal(K.schedule().length, 0, "busy chefs are not given more");
let r = K.completeTask(A); assert.equal(r.completed, false, "order 1 still needs chai");
out = K.schedule(); assert.equal(out.length, 1); assert.equal(out[0].chefId, A); assert.equal(out[0].items[0].id, "samosa", "A helps with samosa when nothing of theirs is waiting");
r = K.completeTask(B); assert.equal(r.completed, true); assert.deepEqual(ready, [o1.number]);
r = K.completeTask(A); assert.equal(r.completed, true); assert.deepEqual(ready, [o1.number, o2.number]);

// --- going offline releases the task, another chef picks it up
const o3 = pay([{ id: "masala_dosa", qty: 1 }]); K.schedule(); assert.equal(K.kitchenView().chefs.find((c) => c.id === A).task.number, o3.number);
K.setOnline(A, false); out = K.schedule(); assert.equal(out[0].chefId, B, "released task goes to the other chef"); K.completeTask(B);

// --- order mode: whole orders, oldest first
K.setKitchen({ mode: "order", chefs: [{ id: A, name: "A" }, { id: B, name: "B" }, { name: "C" }] }); const C = K.kitchenView().chefs[2].id;
K.setOnline(A, true); K.setOnline(C, true); K.setOnline(B, false);
const p1 = pay([{ id: "samosa", qty: 1 }, { id: "chai", qty: 1 }], 2000), p2 = pay([{ id: "chowmein", qty: 1 }], 1000), p3 = pay([{ id: "chai", qty: 1 }]);
out = K.schedule(); assert.equal(out.length, 2); assert.equal(out[0].number, p1.number); assert.equal(out[1].number, p2.number); assert.equal(out[0].items.length, 2, "whole order = all its items");
const first = out[0].chefId; assert.equal(K.completeTask(first).completed, true);
out = K.schedule(); assert.equal(out[0].number, p3.number); assert.equal(out[0].chefId, first, "freed chef immediately gets the next order");

// --- board completion (outside the scheduler) frees the chef
const { markOrderReady } = await import("../src/orders.js"); markOrderReady(p2.number); K.sync();
assert.ok(K.kitchenView().chefs.every((c) => !c.task || c.task.number !== p2.number));
// --- reconfigure: removing a chef frees their work
K.setKitchen({ mode: "order", chefs: [{ id: first, name: "Solo" }] }); assert.equal(K.kitchenView().chefs.length, 1);
flush(); console.log("kitchen ok");
