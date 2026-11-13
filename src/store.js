// Per-shop persistence behind a tiny interface (loadState / saveState), so the file store can be swapped for Postgres/SQLite without
// touching the rest of the code. Atomic writes (tmp file + rename). Single-shop mode keeps today's data/state.json.
import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { isMulti } from "./tenant.js";
export const dataDir = () => process.env.DATA_DIR || fileURLToPath(new URL("../data/", import.meta.url));
const fileFor = (id) => (isMulti() ? join(dataDir(), "tenants", id + ".json") : join(dataDir(), "state.json"));
export function loadState(id) { try { return JSON.parse(readFileSync(fileFor(id), "utf8")); } catch { return null; } }
export function saveState(id, obj) { const f = fileFor(id); mkdirSync(dirname(f), { recursive: true }); const tmp = f + ".tmp"; writeFileSync(tmp, JSON.stringify(obj)); renameSync(tmp, f); }
