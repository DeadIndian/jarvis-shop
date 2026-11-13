# Running many shops on one backend

## Design
One backend process serves every shop (**multi-shop mode**, `TENANCY=multi`, `npm run start:multi`). It is not 200 backends.

- **Shop context.** Each request runs inside the shop it belongs to (`src/tenant.js`, AsyncLocalStorage). `menu`, `orders`, `soldOut`, the kitchen state and the insights all resolve to the *current* shop, so the same code serves a kirana and a canteen side by side with no data shared.
- **Per-shop state in memory, one file per shop** (`data/tenants/<shop>.json`, atomic writes) behind a two-function store (`src/store.js`: `loadState` / `saveState`), so SQLite/Postgres can replace it without touching the rest. Idle shops are flushed and unloaded after 15 min (`TENANT_IDLE_MS`), so memory follows *active* shops.
- **Access.** A shop is created once (name, type, owner PIN) and gets a 6-character **shop code**. Counter and kitchen phones join with the code; the owner role needs the code **and** the PIN (scrypt-hashed, async). Joining returns a signed stateless token (HMAC, role + shop + expiry), so any number of app servers can verify requests without a session store. Each role may only call its own endpoints (`can()` in `src/tenants.js`); wrong PINs lock out after 5 tries for 5 minutes; signups are rate limited per IP (`SIGNUP_KEY` can make them invite-only).
- **Live updates are per shop** (SSE connections belong to the shop), so one shop's order never reaches another's screens.
- **Metering and quotas per shop** (`src/usage.js`): speech-to-text calls and seconds, text-to-speech characters, model calls, per day, with limits (`LIMIT_STT_DAY`, `LIMIT_TTS_CHARS_DAY`, `LIMIT_LLM_DAY`, or a per-shop `plan`). Past a limit the shop degrades gracefully: voice asks the user to type or tap, replies fall back to on-device speech, the parser falls back to rules.
- **Shared model server, bounded.** All shops share one local model server. Calls go through a concurrency gate (`LLM_CONCURRENCY`, default 8, queue 64); beyond that they fail fast to the rules parser, so a busy lunch hour never builds an unbounded backlog. Each shop's own menu travels in its prompt.
- **Operator view:** `/admin.html` with `ADMIN_KEY` lists every shop with orders, revenue and voice usage today.

Single-shop mode (default) is unchanged: no login, one `data/state.json`.

## Measured (this repo, `npm run loadtest`)
One server process, multi-shop mode, 100 kirana + 100 canteens, each shop running 20 full order cycles back to back (voice-parser turn → checkout → pay → ready → hand-over), three live connections per shop (600 SSE streams). No external speech or model calls, so this measures the backend itself. Test machine: 8 cores; the server uses one.

| | |
|---|---|
| Requests | 21,560 in 7.6 s → **2,825 req/s**, **524 orders/s** |
| Latency under that saturating load | p50 ≈ 70 ms, p95 ≈ 100 ms, p99 < 250 ms |
| Memory | peak **197 MB for 200 shops** (~1 MB per active shop) |
| Errors | 0 |
| Isolation | every shop held exactly its own orders and revenue (0 leaks) |

A real shop does perhaps one order a minute at peak, so 200 shops generate about 3 orders/s; the test ran about 150x that. Profiling found QR PNG encoding was 60% of CPU in the first run (719 req/s); switching to SVG QR codes gave the 4x.

**Not measured:** the speech cloud (Sarvam) and the GPU model server under 200 shops; that needs the real services. Network latency to phones; a database-backed store.

## Cost model
Per shop per month = (orders × voice turns × speech cost) + (share of the model server) + (share of the app server).

- **App server:** a small VM covers hundreds of shops (measured above); a few dollars of cost per month per hundred shops.
- **Model server:** one GPU box shared by all shops. Each parse took 0.4–0.8 s on the RTX 6000 box (single-request timing, not a load test). Cost per shop falls as shops are added.
- **Speech (Sarvam):** the one cost that grows with usage. Per order about 5 s of audio in plus about 100 characters spoken out. Fill in the current prices from Sarvam's pricing page: `orders/day × 30 × (5 s × price_per_second_STT + 100 chars × price_per_char_TTS)`. Levers: fixed phrases are cached; menu taps are silent and need no speech; the owner can switch voice off and use typing; per-shop daily quotas cap the worst case.

## What would come next to go beyond one process
1. Replace the file store with Postgres/SQLite (the interface is two functions).
2. Run several app servers; route by shop id (sticky) so each shop's in-memory state lives on exactly one server, or move to a shared store + pub/sub for live updates.
3. Put the model server behind a queue with autoscaling if GPU use grows.
