// Core server-authoritative state machine for the retarget campaign.
//
// Unlike the original daily-cast surface, this is a ONE-TIME allowance: a
// user gets exactly cfg.castsPerDay rolls ever, no daily reset. There is no
// `day` dimension to the gameplay state at all — one row per user_id,
// forever. (todayKey() is still used purely to stamp coin_credit_attempts
// for bookkeeping/analytics, not to gate anything.)
//
// The client can only *request* a roll or a redeem; every decision — rolls
// remaining, reward amount, redemption — is made and recorded here, inside
// DB transactions with row locks, so it is correct under concurrent
// requests from any number of pods and immune to client tampering, replay,
// or refresh-farming.
import { randomInt } from 'node:crypto';
import { query, withTx } from './db.js';
import { loadConfig } from './config.js';
import { todayKey } from './day.js';
import { fireCoinCredit } from './coin-api.js';

const USER_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function isValidUserId(id) {
  return typeof id === 'string' && USER_ID_RE.test(id);
}

export class StateError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
  }
}

// Split `total` into `count` non-negative integers that sum to exactly
// `total`, randomized per user (occasional zeros on individual rolls, varied
// split) — so the user-visible per-roll amounts aren't just total/count.
function splitTotal(total, count) {
  const cuts = Array.from({ length: count - 1 }, () => randomInt(total + 1)).sort((a, b) => a - b);
  const bounds = [0, ...cuts, total];
  const parts = bounds.slice(1).map((b, i) => b - bounds[i]);
  for (let i = parts.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [parts[i], parts[j]] = [parts[j], parts[i]];
  }
  return parts;
}

// Every user is guaranteed exactly one of retarget.totalRewardOptions across
// their castsPerDay rolls combined — never less, never zero. Picked once
// (on first contact) and snapshotted onto the user's row, so it can never
// be re-rolled by a refresh or retry.
function buildRewardPlan(cfg) {
  const options = cfg.retarget.totalRewardOptions;
  const total = options[randomInt(options.length)];
  return splitTotal(total, cfg.castsPerDay);
}

// ---------------------------------------------------------------------------
// State row — one per user_id, forever (no day key).
async function lockState(client, userId, cfg) {
  // Insert-if-absent then lock. ON CONFLICT DO NOTHING makes concurrent
  // first-touch from two pods safe; FOR UPDATE serializes everything after.
  const plan = buildRewardPlan(cfg);
  await client.query(
    `INSERT INTO retarget_spins (user_id, reward_plan)
     VALUES ($1, $2)
     ON CONFLICT (user_id) DO NOTHING`,
    [userId, JSON.stringify(plan)],
  );
  const { rows } = await client.query(
    'SELECT * FROM retarget_spins WHERE user_id = $1 FOR UPDATE',
    [userId],
  );
  return rows[0];
}

async function readState(executor, userId) {
  const { rows } = await executor.query(
    'SELECT * FROM retarget_spins WHERE user_id = $1',
    [userId],
  );
  return rows[0] || null;
}

// ---------------------------------------------------------------------------
// Session payload — the only shape the client ever renders.
function buildSessionPayload({ cfg, state }) {
  const castsUsed = state ? state.casts_used : 0;
  const complete = castsUsed >= cfg.castsPerDay;
  const earned = state ? state.earned : 0;

  return {
    castsPerDay: cfg.castsPerDay,
    castsUsed,
    castsLeft: Math.max(0, cfg.castsPerDay - castsUsed),
    complete,
    walletBalance: earned,
    claimable: earned > 0,
    nav: cfg.nav || null,
    copy: cfg.copy,
  };
}

// ---------------------------------------------------------------------------
// Public operations

export async function getSession(userId) {
  const cfg = loadConfig();
  const state = await readState({ query }, userId);
  return buildSessionPayload({ cfg, state });
}

export async function cast(userId) {
  const cfg = loadConfig();
  return withTx(async (client) => {
    const state = await lockState(client, userId, cfg);
    if (state.casts_used >= cfg.castsPerDay) {
      // Permanent, not "come back tomorrow" — this link only ever grants
      // castsPerDay rolls, once, for the lifetime of the user.
      throw new StateError('EXHAUSTED', 'all free rolls already used');
    }

    const plan = state.reward_plan;
    const reward = Math.max(0, plan[state.casts_used] ?? 0);

    // Guarded update: the WHERE clause re-checks casts_used so even a bug
    // above could never over-count attempts.
    const updated = await client.query(
      `UPDATE retarget_spins
          SET casts_used = casts_used + 1,
              earned = earned + $2,
              updated_at = now()
        WHERE user_id = $1 AND casts_used = $3
        RETURNING *`,
      [userId, reward, state.casts_used],
    );
    if (updated.rowCount !== 1) {
      throw new StateError('CONFLICT', 'concurrent roll detected, retry');
    }

    const payload = buildSessionPayload({ cfg, state: updated.rows[0] });
    return { reward, session: payload };
  });
}

export async function claim(userId) {
  const cfg = loadConfig();
  const day = todayKey(); // bookkeeping only — coin_credit_attempts wants a date

  // Phase 1 — mark the redemption FIRST, in its own transaction. The row
  // lock serializes double-taps; whoever zeroes `earned` is the one claim.
  // There is exactly one row per user (no day dimension), so unlike the
  // original multi-day wallet this never needs to aggregate across rows.
  const marked = await withTx(async (client) => {
    const { rows } = await client.query(
      'SELECT * FROM retarget_spins WHERE user_id = $1 FOR UPDATE',
      [userId],
    );
    const state = rows[0];
    if (!state) {
      throw new StateError('NOTHING_TO_CLAIM', 'nothing to redeem');
    }

    // Stable per-user key (not per-day, there's only ever one redemption).
    const idempotencyKey = `retarget:${userId}`;
    if (state.earned <= 0) {
      // Either never won, or already redeemed. Self-heal: if the one-ever
      // credit attempt under this key never confirmed, hand back its amount
      // so phase 2 below retries instead of silently stranding the credit.
      const { rows: attempt } = await client.query(
        'SELECT amount, status FROM coin_credit_attempts WHERE idempotency_key = $1',
        [idempotencyKey],
      );
      const pending = attempt[0];
      if (!pending || ['success', 'stub_credited'].includes(pending.status)) {
        throw new StateError('NOTHING_TO_CLAIM', 'nothing to redeem');
      }
      return { amount: pending.amount, idempotencyKey };
    }

    const amount = state.earned;
    await client.query(
      `UPDATE retarget_spins
          SET redeemed_amount = redeemed_amount + $2, earned = 0, updated_at = now()
        WHERE user_id = $1`,
      [userId, amount],
    );
    return { amount, idempotencyKey };
  });

  // Phase 2 — fire the credit, at most once ever per idempotency key. The
  // external Coin API has no dedup of its own, so the UNIQUE attempt-row
  // insert inside fireCoinCredit is the gate.
  await fireCoinCredit({ userId, day, amount: marked.amount, idempotencyKey: marked.idempotencyKey });

  const state = await readState({ query }, userId);
  return {
    claimedAmount: marked.amount,
    session: buildSessionPayload({ cfg, state }),
  };
}
