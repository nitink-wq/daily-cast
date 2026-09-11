// Core server-authoritative state machine.
//
// The client can only *request* a cast or a redeem; every decision — attempts
// remaining, reward amount, redemption — is made and recorded here, inside DB
// transactions with row locks, so it is correct under concurrent requests
// from any number of pods and immune to client tampering, replay, or
// refresh-farming.
import { randomUUID } from 'node:crypto';
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

// ---------------------------------------------------------------------------
// Reward plan: a pure lookup into the fixed rewardSchedule, keyed by how many
// days (before today) the user has already played. Deterministic — no
// randomness — so every user wins the same guaranteed amounts on the same
// days (brief: "user should win something for the first 7 days"). Days past
// the schedule pay nothing (the schedule's total already equals the lifetime
// budget). Still defensively clamped to the remaining lifetime budget and the
// per-day cap in case the schedule is ever edited without updating the budget.
function buildRewardPlan(cfg, stats) {
  const lr = cfg.lifetimeReward;
  const dayPlan = lr.rewardSchedule[stats.daysPlayed] || new Array(cfg.castsPerDay).fill(0);
  let room = Math.max(0, lr.totalBudget - stats.lifetimeEarned);
  return dayPlan.map((amount) => {
    const grant = Math.max(0, Math.min(amount, room, cfg.rewardCapPerDay));
    room -= grant;
    return grant;
  });
}

// Lifetime winnings = SUM(earned + redeemed_amount): `earned` moves to
// `redeemed_amount` on redeem, so nothing ever won is double-counted or lost.
async function fetchLifetimeStats(executor, userId, day) {
  const { rows } = await executor.query(
    `SELECT COUNT(*)::int AS days_played,
            COALESCE(SUM(earned + redeemed_amount), 0)::int AS lifetime_earned
       FROM user_daily_states
      WHERE user_id = $1 AND day < $2`,
    [userId, day],
  );
  return { daysPlayed: rows[0].days_played, lifetimeEarned: rows[0].lifetime_earned };
}

// Wallet balance is NOT reset at day rollover — coins won on any day sit in
// that day's `earned` column until the user redeems (brief: no more same-day
// expiry). The wallet total is simply the sum across every day's row.
async function fetchWalletBalance(executor, userId) {
  const { rows } = await executor.query(
    `SELECT COALESCE(SUM(earned), 0)::int AS balance
       FROM user_daily_states WHERE user_id = $1`,
    [userId],
  );
  return rows[0].balance;
}

// ---------------------------------------------------------------------------
// Daily state row
async function lockDailyState(client, userId, day, cfg) {
  // Insert-if-absent then lock. ON CONFLICT DO NOTHING makes concurrent
  // first-touch from two pods safe; FOR UPDATE serializes everything after.
  const stats = await fetchLifetimeStats(client, userId, day);
  const plan = buildRewardPlan(cfg, stats);
  await client.query(
    `INSERT INTO user_daily_states (user_id, day, reward_plan)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id, day) DO NOTHING`,
    [userId, day, JSON.stringify(plan)],
  );
  const { rows } = await client.query(
    'SELECT * FROM user_daily_states WHERE user_id = $1 AND day = $2 FOR UPDATE',
    [userId, day],
  );
  return rows[0];
}

async function readDailyState(executor, userId, day) {
  const { rows } = await executor.query(
    'SELECT * FROM user_daily_states WHERE user_id = $1 AND day = $2',
    [userId, day],
  );
  return rows[0] || null;
}

// ---------------------------------------------------------------------------
// Session payload — the only shape the client ever renders.
function buildSessionPayload({ cfg, day, state, walletBalance }) {
  const castsUsed = state ? state.casts_used : 0;
  const complete = castsUsed >= cfg.castsPerDay;

  return {
    day,
    castsPerDay: cfg.castsPerDay,
    castsUsed,
    castsLeft: Math.max(0, cfg.castsPerDay - castsUsed),
    complete,
    rewardCap: cfg.rewardCapPerDay,
    walletBalance,
    claimable: walletBalance > 0,
    nav: cfg.nav || null,
    copy: cfg.copy,
  };
}

// ---------------------------------------------------------------------------
// Public operations

export async function getSession(userId) {
  const cfg = loadConfig();
  const day = todayKey();
  const [state, walletBalance] = await Promise.all([
    readDailyState({ query }, userId, day),
    fetchWalletBalance({ query }, userId),
  ]);
  return buildSessionPayload({ cfg, day, state, walletBalance });
}

export async function cast(userId) {
  const cfg = loadConfig();
  const day = todayKey();
  return withTx(async (client) => {
    const state = await lockDailyState(client, userId, day, cfg);
    if (state.casts_used >= cfg.castsPerDay) {
      throw new StateError('EXHAUSTED', 'no casts left today');
    }

    const plan = state.reward_plan;
    // Hard cap enforced in logic regardless of plan contents.
    const reward = Math.max(0, Math.min(plan[state.casts_used] ?? 0, cfg.rewardCapPerDay - state.earned));

    // Guarded update: the WHERE clause re-checks casts_used so even a bug
    // above could never over-count attempts.
    const updated = await client.query(
      `UPDATE user_daily_states
          SET casts_used = casts_used + 1,
              earned = LEAST(earned + $3, $4),
              updated_at = now()
        WHERE user_id = $1 AND day = $2 AND casts_used = $5
        RETURNING *`,
      [userId, day, reward, cfg.rewardCapPerDay, state.casts_used],
    );
    if (updated.rowCount !== 1) {
      throw new StateError('CONFLICT', 'concurrent cast detected, retry');
    }

    const walletBalance = await fetchWalletBalance(client, userId);
    const payload = buildSessionPayload({ cfg, day, state: updated.rows[0], walletBalance });
    return { reward, session: payload };
  });
}

export async function claim(userId) {
  const cfg = loadConfig();
  const day = todayKey();

  // Phase 1 — mark the redemption FIRST, in its own transaction. Locking
  // every day-row with unclaimed earned serializes double-taps; whoever
  // wins the lock zeroes them all and is the one redemption.
  const marked = await withTx(async (client) => {
    const { rows } = await client.query(
      'SELECT day, earned FROM user_daily_states WHERE user_id = $1 AND earned > 0 FOR UPDATE',
      [userId],
    );
    const amount = rows.reduce((sum, r) => sum + r.earned, 0);

    if (amount <= 0) {
      // Nothing new to redeem. Self-heal: if the last redemption's coin
      // credit never confirmed, hand back its key/amount so phase 2 below
      // retries instead of silently stranding the credit (mirrors the old
      // per-day `alreadyClaimed` replay, generalised to the wallet model).
      const { rows: pending } = await client.query(
        `SELECT r.amount, r.idempotency_key
           FROM redemptions r
           LEFT JOIN coin_credit_attempts a ON a.idempotency_key = r.idempotency_key
          WHERE r.user_id = $1 AND (a.status IS NULL OR a.status NOT IN ('success', 'stub_credited'))
          ORDER BY r.id DESC LIMIT 1`,
        [userId],
      );
      if (pending.length === 0) {
        throw new StateError('NOTHING_TO_CLAIM', 'nothing to redeem');
      }
      return { amount: pending[0].amount, idempotencyKey: pending[0].idempotency_key };
    }

    const idempotencyKey = randomUUID();
    await client.query(
      'INSERT INTO redemptions (user_id, amount, idempotency_key) VALUES ($1, $2, $3)',
      [userId, amount, idempotencyKey],
    );
    await client.query(
      `UPDATE user_daily_states
          SET redeemed_amount = redeemed_amount + earned, earned = 0, updated_at = now()
        WHERE user_id = $1 AND earned > 0`,
      [userId],
    );
    return { amount, idempotencyKey };
  });

  // Phase 2 — fire the credit, at most once ever per idempotency key. The
  // external Coin API has no dedup of its own, so the UNIQUE attempt-row
  // insert inside fireCoinCredit is the gate.
  await fireCoinCredit({ userId, day, amount: marked.amount, idempotencyKey: marked.idempotencyKey });

  const walletBalance = await fetchWalletBalance({ query }, userId);
  const state = await readDailyState({ query }, userId, day);
  return {
    claimedAmount: marked.amount,
    session: buildSessionPayload({ cfg, day, state, walletBalance }),
  };
}
