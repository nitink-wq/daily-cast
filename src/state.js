// Core server-authoritative state machine (brief §5, §10, §11).
//
// The client can only *request* a cast or a redeem; every decision — attempts
// remaining, roll outcome, content selection, reward amounts, redemption —
// is made and recorded here, inside DB transactions with row locks, so it is
// correct under concurrent requests from any number of pods and immune to
// client tampering, replay, or refresh-farming.
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

// ---------------------------------------------------------------------------
// Reward plan under a LIFETIME budget (experiment runs ~2 weeks): a user's
// total winnings across all days must stay under cfg.lifetimeReward.totalBudget.
// The first days follow a fixed warm-up schedule (e.g. 10, 10, 20); after
// that a day pays only with laterWinChance, so users don't win every day.
// Any grant is at least minGrant; when the remaining budget can't cover
// minGrant the day pays nothing. The day's total is then split across the
// casts (each paying cast >= minGrant) and snapshotted onto the user's daily
// row on first contact so refreshes can't re-roll outcomes.
function computeDayTotal(cfg, { daysPlayed, lifetimeEarned }) {
  const lr = cfg.lifetimeReward;
  const remaining = lr.totalBudget - lifetimeEarned;
  if (remaining < lr.minGrant) return 0;

  let total = 0;
  if (daysPlayed < lr.earlyDaySchedule.length) {
    total = lr.earlyDaySchedule[daysPlayed];
  } else if (randomInt(100) < Math.round(lr.laterWinChance * 100)) {
    const grants = lr.laterGrants.filter((g) => g >= lr.minGrant);
    total = grants.length ? grants[randomInt(grants.length)] : lr.minGrant;
  }
  total = Math.min(total, remaining, cfg.rewardCapPerDay);
  return total >= lr.minGrant ? total : 0;
}

function splitAcrossCasts(total, casts, minGrant) {
  const plan = new Array(casts).fill(0);
  if (total <= 0) return plan;
  // How many casts pay: 1..min(casts, total/minGrant), so every paying cast
  // clears the minimum and small-budget days keep a "no coin" beat or two.
  const maxParts = Math.max(1, Math.min(casts, Math.floor(total / minGrant)));
  const parts = 1 + randomInt(maxParts);
  const amounts = new Array(parts).fill(minGrant);
  let leftover = total - parts * minGrant;
  while (leftover > 0) {
    const unit = Math.min(minGrant, leftover);
    amounts[randomInt(parts)] += unit;
    leftover -= unit;
  }
  const slots = Array.from(plan.keys());
  for (const amount of amounts) {
    const [pick] = slots.splice(randomInt(slots.length), 1);
    plan[pick] = amount;
  }
  return plan;
}

// The reward plan for a user's day. Their FIRST-ever day is deterministic
// (PM 2026-08-04): firstDayPlan pays exactly its listed amounts in roll
// order — 10 on the very first roll, nothing on the rest of day 1. Every
// later day uses the random plan (computeDayTotal + splitAcrossCasts).
// The fixed plan is still clamped to the lifetime budget and the daily cap.
function buildRewardPlan(cfg, stats) {
  const lr = cfg.lifetimeReward;
  if (stats.daysPlayed === 0 && Array.isArray(lr.firstDayPlan) && lr.firstDayPlan.length > 0) {
    let room = Math.min(lr.totalBudget - stats.lifetimeEarned, cfg.rewardCapPerDay);
    return Array.from({ length: cfg.castsPerDay }, (_, i) => {
      const grant = Math.max(0, Math.min(Math.trunc(lr.firstDayPlan[i] || 0), room));
      room -= grant;
      return grant;
    });
  }
  return splitAcrossCasts(computeDayTotal(cfg, stats), cfg.castsPerDay, lr.minGrant);
}

// Lifetime winnings = SUM(earned + redeemed_amount): `earned` is zeroed on
// redeem (the visible balance drops to 0) and the paid amount moves to
// `redeemed_amount`; expired unredeemed coins keep counting via `earned`.
async function fetchLifetimeStats(executor, userId, day) {
  const { rows } = await executor.query(
    `SELECT COUNT(*)::int AS days_played,
            COALESCE(SUM(earned + COALESCE(redeemed_amount, 0)), 0)::int AS lifetime_earned
       FROM user_daily_states
      WHERE user_id = $1 AND day < $2`,
    [userId, day],
  );
  return { daysPlayed: rows[0].days_played, lifetimeEarned: rows[0].lifetime_earned };
}

// ---------------------------------------------------------------------------
// Pool access
async function fetchPoolDay(executor, day) {
  const { rows } = await executor.query(
    'SELECT day, anchor FROM content_pool_days WHERE day = $1',
    [day],
  );
  return rows[0] || null;
}

async function fetchPoolItems(executor, day) {
  const { rows } = await executor.query(
    `SELECT item_id, chapter_index, body, open_question
       FROM content_pool_items WHERE day = $1
       ORDER BY item_id`,
    [day],
  );
  return rows;
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
// Session payload — the only shape the client ever renders. Locked chapters
// carry no content; the consult nudge (with the deeplink) appears only at
// Complete.
function buildConsultUrl(cfg, day, selections) {
  const base = cfg.consultTarget.deeplink;
  const params = new URLSearchParams({
    src: 'daily_cast',
    day,
    rolls: selections.map((s) => s.roll).join('-'),
  });
  return `${base}${base.includes('?') ? '&' : '?'}${params.toString()}`;
}

function buildSessionPayload({ cfg, day, poolDay, items, state }) {
  const itemsById = new Map(items.map((i) => [i.item_id, i]));
  const selections = state ? state.selections : [];
  const castsUsed = state ? state.casts_used : 0;
  const earned = state ? state.earned : 0;
  const claimed = Boolean(state && state.redeemed_at);
  const complete = castsUsed >= cfg.castsPerDay;

  const chapters = cfg.chapters.map((chapter, index) => {
    const selection = selections.find((s) => s.chapterIndex === index);
    if (!selection) {
      return { index, label: chapter.label, openLoop: Boolean(chapter.openLoop), state: 'locked' };
    }
    const item = itemsById.get(selection.itemId);
    return {
      index,
      label: chapter.label,
      openLoop: Boolean(chapter.openLoop),
      state: 'unlocked',
      roll: selection.roll,
      body: item ? item.body : null,
    };
  });

  return {
    day,
    dayAnchor: poolDay ? poolDay.anchor : null,
    castsPerDay: cfg.castsPerDay,
    castsUsed,
    castsLeft: Math.max(0, cfg.castsPerDay - castsUsed),
    complete,
    rewardCap: cfg.rewardCapPerDay,
    earned,
    claimed,
    claimable: earned > 0 && !claimed,
    chapters,
    nudge: complete ? { consultUrl: buildConsultUrl(cfg, day, selections) } : null,
    nav: cfg.nav || null,
    copy: cfg.copy,
  };
}

// ---------------------------------------------------------------------------
// Public operations

export async function getSession(userId) {
  const cfg = loadConfig();
  const day = todayKey();
  const poolDay = await fetchPoolDay({ query }, day);
  if (!poolDay) throw new StateError('POOL_MISSING', `no content pool for ${day}`);
  const [items, state] = await Promise.all([
    fetchPoolItems({ query }, day),
    readDailyState({ query }, userId, day),
  ]);
  return buildSessionPayload({ cfg, day, poolDay, items, state });
}

export async function cast(userId) {
  const cfg = loadConfig();
  const day = todayKey();
  return withTx(async (client) => {
    const poolDay = await fetchPoolDay(client, day);
    if (!poolDay) throw new StateError('POOL_MISSING', `no content pool for ${day}`);
    const items = await fetchPoolItems(client, day);

    const state = await lockDailyState(client, userId, day, cfg);
    if (state.casts_used >= cfg.castsPerDay) {
      throw new StateError('EXHAUSTED', 'no casts left today');
    }

    // Casts are strictly sequential: this cast always unlocks the next
    // chapter in order (brief §5) — no skipping, no re-rolling.
    const chapterIndex = state.casts_used;
    const usedItemIds = new Set(state.selections.map((s) => s.itemId));
    const candidates = items.filter(
      (i) => i.chapter_index === chapterIndex && !usedItemIds.has(i.item_id),
    );
    if (candidates.length === 0) {
      throw new StateError('POOL_MISSING', `no pool items for chapter ${chapterIndex} on ${day}`);
    }
    const picked = candidates[randomInt(candidates.length)];
    const roll = randomInt(1, 7); // die face 1..6, server-decided

    const plan = state.reward_plan;
    // Hard cap enforced in logic regardless of plan contents (brief §8).
    const reward = Math.max(0, Math.min(plan[chapterIndex] ?? 0, cfg.rewardCapPerDay - state.earned));

    const selections = [
      ...state.selections,
      { cast: chapterIndex + 1, chapterIndex, itemId: picked.item_id, roll, reward },
    ];

    // Guarded update: the WHERE clause re-checks casts_used so even a bug
    // above could never over-count attempts.
    const updated = await client.query(
      `UPDATE user_daily_states
          SET casts_used = casts_used + 1,
              earned = LEAST(earned + $3, $4),
              selections = $5::jsonb,
              updated_at = now()
        WHERE user_id = $1 AND day = $2 AND casts_used = $6
        RETURNING *`,
      [userId, day, reward, cfg.rewardCapPerDay, JSON.stringify(selections), state.casts_used],
    );
    if (updated.rowCount !== 1) {
      throw new StateError('CONFLICT', 'concurrent cast detected, retry');
    }

    const payload = buildSessionPayload({ cfg, day, poolDay, items, state: updated.rows[0] });
    return { roll, chapterIndex, reward, session: payload };
  });
}

export async function claim(userId) {
  const cfg = loadConfig();
  const day = todayKey();

  // Phase 1 — record the redemption FIRST, in its own transaction. The row
  // lock serializes double-taps; whoever flips redeemed_at is the one claim.
  // No insert here: claiming requires an existing same-day record, and only
  // ever looks at today's row — yesterday's unredeemed earnings are
  // unreachable by construction (same-day expiry, brief §10.2).
  const marked = await withTx(async (client) => {
    const { rows } = await client.query(
      'SELECT * FROM user_daily_states WHERE user_id = $1 AND day = $2 FOR UPDATE',
      [userId, day],
    );
    const state = rows[0];
    if (!state) {
      throw new StateError('NOTHING_TO_CLAIM', 'nothing earned today');
    }
    const idempotencyKey = state.redeem_ref || `dailycast:${userId}:${day}`;
    if (state.redeemed_at) {
      // earned was zeroed by the first claim; the paid amount lives on.
      return { alreadyClaimed: true, amount: state.redeemed_amount || 0, idempotencyKey };
    }
    if (state.earned <= 0) {
      throw new StateError('NOTHING_TO_CLAIM', 'nothing earned today');
    }
    // Amount comes from server state only; the client never submits it.
    // The visible balance drops to 0 on redeem (PM requirement); the amount
    // moves to redeemed_amount so lifetime accounting and repeats still work.
    const amount = Math.min(state.earned, cfg.rewardCapPerDay);
    await client.query(
      `UPDATE user_daily_states
          SET redeem_ref = $3, redeemed_at = now(),
              redeemed_amount = $4, earned = 0, updated_at = now()
        WHERE user_id = $1 AND day = $2`,
      [userId, day, idempotencyKey, amount],
    );
    return { alreadyClaimed: false, amount, idempotencyKey };
  });

  // Phase 2 — fire the credit, at most once ever. The external Coin API has
  // no dedup of its own, so the UNIQUE attempt-row insert inside
  // fireCoinCredit is the gate. Called on every claim (repeats included) so
  // a crash between phases self-heals on the next tap instead of stranding
  // the credit; anything after the first firing is suppressed by the gate.
  await fireCoinCredit({ userId, day, amount: marked.amount, idempotencyKey: marked.idempotencyKey });

  const poolDay = await fetchPoolDay({ query }, day);
  const items = poolDay ? await fetchPoolItems({ query }, day) : [];
  const state = await readDailyState({ query }, userId, day);
  return {
    alreadyClaimed: marked.alreadyClaimed || undefined,
    claimedAmount: marked.amount,
    session: buildSessionPayload({ cfg, day, poolDay, items, state }),
  };
}
