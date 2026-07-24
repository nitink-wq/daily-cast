# Daily Cast — AstroLokal retention + conversion test surface

A once-a-day dice "cast" ritual: each cast unlocks one chapter of a single
daily reading, a small capped coin reward accumulates alongside it, the final
chapter deliberately ends on an open question, and a consult nudge appears
only after the last cast. Lightweight webview client + small trusted backend;
the server is the single source of truth for attempts, earnings, content
selection, and coin crediting.

## Stack

- **Runtime:** Node 24 (current LTS), ESM
- **Web:** Express 5 (serves the static page + 3 JSON endpoints)
- **DB:** any Postgres-compliant database via `pg` — configured only by
  `DATABASE_URL` (works with RDS, Cloud SQL, Supabase, Neon, vanilla PG)
- **Migrations:** `node-pg-migrate` (the standard migration tool for
  node-postgres) — applied migrations are ledgered in `pgmigrations`, so each
  runs exactly once per database
- **Frontend:** a single `public/index.html`, inline CSS/JS, no framework, no
  build step, no external assets — styled to the Lokal app design language

## Run locally

```bash
docker compose up --build
# open http://localhost:3000/?user_id=test-user-1
```

Compose brings up Postgres, runs migrations once (`migrate`), publishes
today's content pool once (`pool`, idempotent), then starts the app. Without
`?user_id=...` the page shows the "open from the app" blocked state (§9 of
the brief).

Without Docker (needs Node 24 + a local Postgres):

```bash
npm install
cp .env.example .env            # point DATABASE_URL at your DB
npm run migrate:up
npm run pool:generate           # publish today's pool
npm run dev
```

## Layout

```
config/experiment.config.json   All content + A/B knobs (chapters, cap, copy, astrologer, deeplink)
migrations/                     node-pg-migrate migrations (one per schema change)
scripts/generate-daily-pool.js  Daily pool job; the AI generation hook lives here
src/db.js                       Generic Postgres client (pool + transactions)
src/state.js                    Server-authoritative state machine (cast / claim / session)
src/coin-api.js                 Sealed Coin API adapter (live or idempotent stub)
src/server.js                   HTTP layer, health probes, graceful shutdown
public/index.html               The entire client
k8s/                            Deployment (3 replicas), Service, migrate Job, pool CronJob, config/secret
```

## API (client ↔ server contract)

| Endpoint | Purpose |
|---|---|
| `GET /api/session?user_id=` | Full render state: anchor, casts left, unlocked chapters (content only for unlocked ones), earnings, nudge (only at Complete) |
| `POST /api/cast` `{user_id}` | Server rolls the die, picks the next chapter's content from today's pool, records it, returns the roll + new session |
| `POST /api/claim` `{user_id}` | Server computes the amount from its own records, credits via the sealed Coin API (idempotent), marks redeemed |

The client never submits amounts, roll outcomes, or content ids — it can only
*request* a cast or a claim; a tampered client gets nothing extra.

## Re-contenting / A/B (no code changes)

Everything user-visible lives in `config/experiment.config.json`:

- **Chapters** — count (= casts per day), labels, variant pools, which one is
  the open-loop chapter (`openLoop: true`, exactly one; its variants must
  carry `openQuestion`).
- **`rewardCapPerDay`** — the hard per-day clamp (also the `{max}` shown in
  the prize pill).
- **`lifetimeReward`** — the ~2-week experiment budget: a user's total
  winnings across ALL days stay under `totalBudget` (90, i.e. strictly under
  the promised 100). The first participation days follow `earlyDaySchedule`
  (e.g. 10, 10, 20); after that a day pays only with `laterWinChance`
  (amount from `laterGrants`), so users don't win every day. Every payout is
  at least `minGrant`; the day's total is split across the casts and
  snapshotted per user per day so refreshes can't re-roll it.
- **`copy`** — every string on the page, including blocked/error states.
- **`astrologer` / `consultTarget`** — nudge identity and CTA deeplink; the
  server appends context (`src`, `day`, `rolls`, open-question item id).

Locally: edit + restart. In k8s: update the `daily-cast-config` ConfigMap and
roll the deployment.

## Daily content pool (§11)

`scripts/generate-daily-pool.js` publishes one pool per IST day:
`content_pool_days` (day + astro anchor) and `content_pool_items` (~20–30
items, ids 1..N, partitioned by chapter). The AI step is stubbed with the
config's `sampleVariants` — swap the `generateItems()` function for a real
model call; storage and serving don't change. On a user's first cast the
selected item id is persisted to their daily record, so their 3 chapters are
identical on every revisit that day. Partitioning by chapter guarantees one
user's chapters never collide on an item.

In production the script runs as the `daily-cast-pool` CronJob (00:05 IST).
It is idempotent; `--force` replaces a day's pool but refuses if any user
already cast that day.

## Integrity model (§10)

- **Attempts:** `user_daily_states (user_id, day)` with `casts_used`, mutated
  only inside a transaction under `SELECT ... FOR UPDATE` plus a guarded
  `WHERE casts_used = $expected` update — correct across pods, immune to
  replay/refresh farming.
- **Earnings & expiry:** `earned` accumulates server-side, clamped to the cap
  in SQL (`LEAST`). Claim only ever reads *today's* row, so unredeemed
  earnings expire at the IST day boundary by construction — no cleanup job
  needed to enforce expiry. On redeem, `earned` is reset to 0 (the balance
  the user sees drops to zero) and the paid amount moves to
  `redeemed_amount`, so lifetime accounting — SUM(earned + redeemed_amount)
  over a user's day rows, enforced against `lifetimeReward.totalBudget` at
  each day's first contact — never loses redeemed or expired winnings.
- **Redemption (record-first, fire-once):** the external Coin API
  (`POST /v1/system-transactions/`, HTTP Basic auth) has **no idempotency of
  its own** — it credits on every call. So the server (1) marks the user-day
  redeemed in its own transaction (the row lock serializes double-taps), then
  (2) fires the API gated by a UNIQUE-key insert into `coin_credit_attempts`
  — at most one firing can ever win that insert, across any number of pods.
  Failed/timed-out attempts are recorded but never auto-refired (blind
  retries against a no-dedup API risk double credit); rows with a
  non-success status are the reconciliation worklist. A crash between (1)
  and (2) self-heals: the next tap re-enters phase 2 and the gate decides.
- **Sealed Coin API:** `src/coin-api.js` is the only crediting path and runs
  server-side only. `COIN_API_URL`/`COIN_API_USER`/`COIN_API_PASS` live in
  env/Secrets and are never sent to the client; when unset, the attempt
  table stands in as a stub ledger with identical at-most-once semantics.
- **Known scope cut (flagged for prod):** `user_id` is treated as an opaque
  bearer identifier per the brief — anyone who knows a user_id can act as
  that user. Before real traffic, replace it with a signed/expiring token
  minted by the app; only `requireUser()` in `src/server.js` needs to change.

## Kubernetes deploy

```bash
kubectl apply -f k8s/secret.example.yaml     # or create the real secret out-of-band
kubectl create configmap daily-cast-config \
  --from-file=experiment.config.json=config/experiment.config.json \
  --dry-run=client -o yaml | kubectl apply -f -

kubectl apply -f k8s/migrate-job.yaml        # run-once migrations, then:
kubectl wait --for=condition=complete job/daily-cast-migrate --timeout=120s
kubectl apply -f k8s/deployment.yaml         # 3 stateless replicas + Service
kubectl apply -f k8s/pool-cronjob.yaml       # daily content pool
```

Pods are stateless (no in-memory gameplay state, no sticky sessions); scale
`replicas` freely. Deploy order every release: migrate Job → wait → roll the
Deployment.

## Schema changes

Every DB change is its own migration:

```bash
npm run migrate:create -- my_change_name    # scaffolds migrations/<ts>_my-change-name.cjs
npm run migrate:up                          # apply locally
```

Commit the migration file; the deploy Job applies it exactly once in each
environment.
