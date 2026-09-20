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

// recharge_count comes from the client's URL query string, so it's untrusted
// input — never NaN/negative/non-integer past this point. Missing or
// malformed values fail safe to 0 (the capped, "no active stream account"
// regime), never to the uncapped one.
export function normalizeRechargeCount(raw) {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
}

function randomInt(min, max) {
  return min + Math.floor(Math.random() * (max - min + 1));
}

// Day 8+ payout for accounts with an active recharge (RC>0): no lifetime cap,
// just a per-roll random draw — usually minReward..maxReward, rarely (by
// jackpotChance) a bigger jackpotMin..jackpotMax draw. True randomness here
// is deliberate, unlike the deterministic first-7-days schedule below.
function drawPostScheduleReward(psr) {
  if (Math.random() < psr.jackpotChance) return randomInt(psr.jackpotMin, psr.jackpotMax);
  return randomInt(psr.minReward, psr.maxReward);
}

// ---------------------------------------------------------------------------
// Reward plan for the user's next day of casts, keyed by how many days
// (before today) they've already played.
//
// Days 0-6: a pure lookup into the fixed rewardSchedule. Deterministic — no
// randomness — so every user wins the same guaranteed amounts on the same
// days (brief: "user should win something for the first 7 days"), clamped to
// the remaining lifetime budget and the per-day cap in case the schedule is
// ever edited without updating the budget. recharge_count has no effect here.
//
// Day 7+: RC=0 still pays nothing (lifetime winnings stay capped at
// totalBudget, same as today). RC>0 switches to drawPostScheduleReward with
// no lifetime-budget or per-day-cap clamping — "unlocked" is returned
// alongside the plan so cast() knows to skip those clamps for this day.
function buildRewardPlan(cfg, stats, rechargeCount) {
  const lr = cfg.lifetimeReward;
  const scheduled = lr.rewardSchedule[stats.daysPlayed];
  if (scheduled) {
    let room = Math.max(0, lr.totalBudget - stats.lifetimeEarned);
    const plan = scheduled.map((amount) => {
      const grant = Math.max(0, Math.min(amount, room, cfg.rewardCapPerDay));
      room -= grant;
      return grant;
    });
    return { plan, unlocked: false };
  }

  if (rechargeCount > 0) {
    const plan = Array.from({ length: cfg.castsPerDay }, () => drawPostScheduleReward(lr.postScheduleRandomReward));
    return { plan, unlocked: true };
  }

  return { plan: new Array(cfg.castsPerDay).fill(0), unlocked: false };
}

// user_daily_states.reward_plan was a bare array before postScheduleRandomReward
// existed; accept that shape too so old rows don't break.
function planAndUnlocked(rewardPlanJson) {
  return Array.isArray(rewardPlanJson) ? { plan: rewardPlanJson, unlocked: false } : rewardPlanJson;
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
async function lockDailyState(client, userId, day, cfg, rechargeCount) {
  // Insert-if-absent then lock. ON CONFLICT DO NOTHING makes concurrent
  // first-touch from two pods safe; FOR UPDATE serializes everything after.
  // Whichever recharge_count is present at this first touch decides the
  // whole day's plan — later same-day changes to it don't retroactively
  // reshuffle an already-frozen plan, same as the schedule days always did.
  const stats = await fetchLifetimeStats(client, userId, day);
  const rewardPlan = buildRewardPlan(cfg, stats, rechargeCount);
  await client.query(
    `INSERT INTO user_daily_states (user_id, day, reward_plan)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id, day) DO NOTHING`,
    [userId, day, JSON.stringify(rewardPlan)],
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

export async function cast(userId, rechargeCount = 0) {
  const cfg = loadConfig();
  const day = todayKey();
  return withTx(async (client) => {
    const state = await lockDailyState(client, userId, day, cfg, rechargeCount);
    if (state.casts_used >= cfg.castsPerDay) {
      throw new StateError('EXHAUSTED', 'no casts left today');
    }

    const { plan, unlocked } = planAndUnlocked(state.reward_plan);
    // Unlocked (RC>0, day 8+) days have no lifetime-budget or per-day-cap
    // clamp — a jackpot roll is allowed to actually pay out above the normal
    // daily cap. Every other day keeps the hard cap regardless of plan
    // contents.
    const dailyCap = unlocked ? 1_000_000_000 : cfg.rewardCapPerDay;
    const reward = Math.max(0, Math.min(plan[state.casts_used] ?? 0, dailyCap - state.earned));

    // Guarded update: the WHERE clause re-checks casts_used so even a bug
    // above could never over-count attempts.
    const updated = await client.query(
      `UPDATE user_daily_states
          SET casts_used = casts_used + 1,
              earned = LEAST(earned + $3, $4),
              updated_at = now()
        WHERE user_id = $1 AND day = $2 AND casts_used = $5
        RETURNING *`,
      [userId, day, reward, dailyCap, state.casts_used],
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
