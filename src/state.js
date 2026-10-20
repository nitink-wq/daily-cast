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
// Reward plan: a pure lookup into walletTiers by the user's current AstroLokal
// wallet balance (from the Redash sync). Deterministic and the same every day
// — no day index, no lifetime budget. A balance goes to the first tier whose
// maxBalance it is <= (boundaries belong to the lower tier); the last tier is
// open-ended. Still clamped to the per-day cap in case the tiers are ever
// edited past it.
function buildRewardPlan(cfg, walletBalance) {
  const tier = cfg.walletTiers.tiers.find((t) => t.maxBalance === null || walletBalance <= t.maxBalance);
  let room = cfg.rewardCapPerDay;
  const plan = tier.rewards.map((amount) => {
    const grant = Math.max(0, Math.min(amount, room));
    room -= grant;
    return grant;
  });
  // The balance + tier ride along with the plan so analysis can tell which
  // tier each user-day was paid from.
  return { plan, walletBalance, tierMaxBalance: tier.maxBalance };
}

// reward_plan was a bare array before wallet tiers existed; accept both shapes.
function planOf(rewardPlanJson) {
  return Array.isArray(rewardPlanJson) ? rewardPlanJson : rewardPlanJson.plan;
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

// The user's AstroLokal wallet balance from the Redash sync
// (src/redash-sync.js, refreshed every 5 min) — read from our own mirror
// table, never Redash directly — or null when they aren't in it. The query
// itself only returns users who've talked 5+ minutes today, so presence
// unlocks the dice and the balance drives the reward tier.
async function fetchSyncedWalletBalance(executor, userId) {
  const { rows } = await executor.query(
    'SELECT current_wallet_balance FROM redash_wallet_sync WHERE user_id = $1',
    [userId],
  );
  return rows.length > 0 ? Number(rows[0].current_wallet_balance) : null;
}

// ---------------------------------------------------------------------------
// Daily state row
async function lockDailyState(client, userId, day, cfg, walletBalance) {
  // Insert-if-absent then lock. ON CONFLICT DO NOTHING makes concurrent
  // first-touch from two pods safe; FOR UPDATE serializes everything after.
  // The balance at this first touch decides the whole day's plan — spending
  // or redeeming between rolls can't re-tier an already-frozen plan.
  const plan = buildRewardPlan(cfg, walletBalance);
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
function buildSessionPayload({ cfg, day, state, walletBalance, syncedBalance }) {
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
    bookingUnlocked: syncedBalance !== null,
    nav: cfg.nav || null,
    copy: cfg.copy,
  };
}

// ---------------------------------------------------------------------------
// Public operations

export async function getSession(userId) {
  const cfg = loadConfig();
  const day = todayKey();
  const [state, walletBalance, syncedBalance] = await Promise.all([
    readDailyState({ query }, userId, day),
    fetchWalletBalance({ query }, userId),
    fetchSyncedWalletBalance({ query }, userId),
  ]);
  return buildSessionPayload({ cfg, day, state, walletBalance, syncedBalance });
}

export async function cast(userId) {
  const cfg = loadConfig();
  const day = todayKey();
  return withTx(async (client) => {
    const syncedBalance = await fetchSyncedWalletBalance(client, userId);
    if (syncedBalance === null) {
      throw new StateError('BOOKING_REQUIRED', 'no 5-minute booking today');
    }

    const state = await lockDailyState(client, userId, day, cfg, syncedBalance);
    if (state.casts_used >= cfg.castsPerDay) {
      throw new StateError('EXHAUSTED', 'no casts left today');
    }

    const plan = planOf(state.reward_plan);
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
    const payload = buildSessionPayload({ cfg, day, state: updated.rows[0], walletBalance, syncedBalance });
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

  const [walletBalance, state, syncedBalance] = await Promise.all([
    fetchWalletBalance({ query }, userId),
    readDailyState({ query }, userId, day),
    fetchSyncedWalletBalance({ query }, userId),
  ]);
  return {
    claimedAmount: marked.amount,
    session: buildSessionPayload({ cfg, day, state, walletBalance, syncedBalance }),
  };
}
