# Daily Cast — AstroLokal "Roll & Win" daily dice

A once-a-day dice ritual inside the AstroLokal app's webview. A user who has
talked to an astrologer for 5 minutes today gets 3 rolls; each roll can win
coins, which collect in a persistent wallet the user redeems into their real
AstroLokal wallet. How much a user wins depends on their current AstroLokal
wallet balance. Lightweight webview client + small trusted backend; the server
is the single source of truth for unlocks, rolls, rewards and coin crediting.

## Stack

- **Runtime:** Node 24 (current LTS), ESM
- **Web:** Express 5 (serves the static page + JSON endpoints)
- **DB:** any Postgres-compliant database via `pg` — configured only by
  `DATABASE_URL` (works with RDS, Cloud SQL, Supabase, Neon, vanilla PG)
- **Migrations:** `node-pg-migrate` — applied migrations are ledgered in
  `pgmigrations`, so each runs exactly once per database
- **Frontend:** a single `public/index.html`, inline CSS/JS, no framework, no
  build step, no external assets — styled to the Lokal app design language

## Run locally

```bash
docker compose up --build
# open http://localhost:3000/?user_id=test-user-1
```

Compose brings up Postgres, runs migrations once (`migrate`), then starts the
app. Without `?user_id=...` the page shows the "Login required" state.

Without Docker (needs Node 24 + a local Postgres):

```bash
npm install
cp .env.example .env            # point DATABASE_URL at your DB
node --env-file=.env node_modules/.bin/node-pg-migrate up
node --env-file=.env --watch src/server.js
```

Locally the Redash sync is off (no `REDASH_*` vars), so every user's dice is
locked. Fake an eligible user (balance picks their reward tier):

```bash
psql "$DATABASE_URL" -c "INSERT INTO redash_wallet_sync (user_id, current_wallet_balance) VALUES ('test-user-1', 30);"
```

With `COIN_API_URL` unset, redeeming only writes to the local
`coin_credit_attempts` table — no real coins are credited.

## Layout

```
config/experiment.config.json   All tunables + every user-visible string (tiers, cap, copy, deeplink)
migrations/                     node-pg-migrate migrations (one per schema change)
src/server.js                   HTTP layer, rate limits, analytics sink, Redash timer, shutdown
src/state.js                    Server-authoritative state machine (session / cast / claim)
src/redash-sync.js              Polls the Redash query every 5 min into redash_wallet_sync
src/coin-api.js                 Sealed Coin API adapter (live or at-most-once stub)
src/config.js                   Loads + validates the experiment config (fails fast at boot)
src/db.js                       Generic Postgres client (pool + transactions)
src/day.js                      IST product-day helpers
public/index.html               The entire client
k8s/                            Deployment, Service, migrate Job, ConfigMap, Secret example
```

## API (client ↔ server contract)

| Endpoint | Purpose |
|---|---|
| `GET /api/session?user_id=` | Full render state: rolls used/left, wallet balance, whether the dice is unlocked, copy |
| `POST /api/cast` `{user_id}` | Server checks the unlock, fixes the day's rewards on the first roll, records the roll, returns the reward + new session |
| `POST /api/claim` `{user_id}` | Server sums the unredeemed wallet, credits it via the sealed Coin API (at most once), zeroes the wallet |
| `POST /api/track` | Fire-and-forget analytics (allowlisted `viewed_*` / `tap_*` events) |
| `GET /healthz`, `/readyz` | Liveness / readiness (readyz pings the DB) |

The client never submits amounts or roll outcomes — it can only *request* a
roll or a redeem; a tampered client gets nothing extra.

## Dice unlock + reward tiers (Redash)

A saved Redash query is the only source of booking and wallet data. Every 5
minutes `src/redash-sync.js` fetches its latest cached result (it does not
trigger a re-run — set the query's own refresh schedule to ~5 min) and fully
replaces the `redash_wallet_sync` table with it, under an advisory lock.
Request code only ever reads that table; if Redash is down, the last good
data stays.

- **Unlock:** a user is in the query result ⇔ they've talked 5+ minutes today
  ⇔ their dice is unlocked. The threshold lives in the SQL (`HAVING … >= 300`);
  the "5 minutes" in `copy.locked.body` / `copy.cast.bookTomorrowNote` must be
  kept in step with it.
- **Reward tier:** `current_wallet_balance` picks the user's tier from
  `walletTiers` at their **first roll of the day**; the day's 3 rewards are then
  frozen in `user_daily_states.reward_plan` (with the balance and tier used),
  so spending or redeeming mid-day can't change them.
- **Locked users** still get the full page: their wallet and Redeem work, only
  the dice is locked, with a "Talk Now!" button back to the app.

The query (lives in Redash, not run by this app):

```sql
WITH bounds AS (
  SELECT date_trunc('day', NOW() + INTERVAL '330 minutes') - INTERVAL '330 minutes' AS day_start  -- today's IST midnight, in UTC
),
eligible AS (
  SELECT b.user_id
  FROM bookings_booking b, bounds
  WHERE b.status = 'completed'
    AND b.ended_at IS NOT NULL
    AND b.started_at >= bounds.day_start
    AND b.started_at <  bounds.day_start + INTERVAL '1 day'
    AND NOT EXISTS (SELECT 1 FROM experts_expert e WHERE e.user_id = b.user_id)
  GROUP BY b.user_id
  HAVING SUM(EXTRACT(EPOCH FROM (b.ended_at - b.started_at))) >= 300   -- 5 minutes total today
)
SELECT el.user_id, w.balance AS current_wallet_balance
FROM eligible el
LEFT JOIN wallets_wallet w ON w.user_id = el.user_id
ORDER BY el.user_id;
```

The DB stores timestamps in UTC, so the query adds 330 minutes (+5:30) to
find today's IST midnight and converts it back to UTC for the comparison —
the day runs midnight to midnight IST, matching the app's own IST day
(`src/day.js`).

The sync needs exactly the columns `user_id` and `current_wallet_balance`
(a `null` balance counts as 0). Each `user_id` must appear once —
`redash_wallet_sync.user_id` is a primary key, so a duplicate fails the whole
refresh and the table stops updating until it's fixed.

## Re-contenting / A/B (no code changes)

Everything tunable lives in `config/experiment.config.json`:

- **`castsPerDay`** — rolls per day.
- **`rewardCapPerDay`** — hard per-day clamp on winnings (currently 50).
- **`walletTiers.tiers`** — `[{ maxBalance, rewards: [roll1, roll2, roll3] }]`,
  ascending; a balance goes to the first tier whose `maxBalance` it is ≤
  (boundaries belong to the lower tier), the last tier has `maxBalance: null`.
  `0` = Better luck. Same every day — no day index, no lifetime budget.
- **`coinCredit`** — fields sent to the Coin API.
- **`nav.backDeeplink`** — where back / "Talk Now!" go outside the RN bridge.
- **`copy`** — every string on the page, including blocked/locked/error states.

`src/config.js` validates the shape at boot and refuses to start on a broken
config. Locally: edit + restart. In k8s: update the `daily-cast-config`
ConfigMap and roll the deployment — **the ConfigMap must match the code's
config shape**, or the pods won't start.

## Integrity model

- **Rolls:** `user_daily_states (user_id, day)` with `casts_used`, mutated only
  inside a transaction under `SELECT ... FOR UPDATE` plus a guarded
  `WHERE casts_used = $expected` update — correct across pods, immune to
  replay/refresh farming. The unlock is re-checked server-side on every roll.
- **Wallet:** winnings accumulate in `earned` and persist across days until
  redeemed (no expiry); the wallet is `SUM(earned)` over the user's day rows.
  On redeem, `earned` moves to `redeemed_amount`.
- **Redemption (record-first, fire-once):** the external Coin API
  (`POST /v1/system-transactions/`, HTTP Basic auth) has **no idempotency of
  its own** — it credits on every call. So the server (1) records the redeem in
  `redemptions` and zeroes the wallet in one transaction (the row locks
  serialize double-taps), then (2) fires the API gated by a UNIQUE-key insert
  into `coin_credit_attempts` — at most one firing can ever win that insert,
  across any number of pods. Failed/timed-out attempts are recorded but never
  auto-refired; rows with a non-success status are the reconciliation
  worklist. A crash between (1) and (2) self-heals on the next tap.
- **Sealed Coin API:** `src/coin-api.js` is the only crediting path and runs
  server-side only. `COIN_API_URL`/`COIN_API_USER`/`COIN_API_PASS` live in
  env/Secrets and are never sent to the client; when unset, the attempt table
  stands in as a stub ledger with identical at-most-once semantics.
- **Known scope cut (flagged for prod):** `user_id` is treated as an opaque
  bearer identifier — anyone who knows a user_id can act as that user. Before
  real traffic, replace it with a signed/expiring token minted by the app; only
  `requireUser()` in `src/server.js` needs to change. Rate limits are
  in-memory per pod, so they loosen as replicas are added.

## Kubernetes deploy

```bash
kubectl apply -f k8s/secret.example.yaml     # or create the real secret out-of-band
kubectl create configmap daily-cast-config \
  --from-file=experiment.config.json=config/experiment.config.json \
  --dry-run=client -o yaml | kubectl apply -f -

kubectl apply -f k8s/migrate-job.yaml        # run-once migrations, then:
kubectl wait --for=condition=complete job/daily-cast-migrate --timeout=120s
kubectl apply -f k8s/deployment.yaml         # stateless replicas + Service
```

The secret must also carry `REDASH_HOST`, `REDASH_QUERY_ID` and
`REDASH_API_KEY` for the unlock/tier sync (without them every dice stays
locked). Pods are stateless (no in-memory gameplay state, no sticky
sessions). Deploy order every release: migrate Job → wait → update the
ConfigMap → roll the Deployment. `k8s/pool-cronjob.yaml` is obsolete (the
daily content pool was removed) and kept only for reference.

## Schema changes

Every DB change is its own migration:

```bash
npm run migrate:create -- my_change_name    # scaffolds migrations/<ts>_my-change-name.cjs
npm run migrate:up                          # apply locally
```

Commit the migration file; the deploy Job applies it exactly once in each
environment.
