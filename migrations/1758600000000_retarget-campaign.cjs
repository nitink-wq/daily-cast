/**
 * Retarget campaign: a one-time link, not a daily surface.
 *
 * ADDITIVE, not destructive: `redemptions`, `user_daily_states`, and
 * `redash_wallet_sync` (from the previous daily-dice/booking-gate lineage
 * this DB was running) are left exactly as they are — real wallet/
 * redemption history must not be touched. The new code never reads or
 * writes any of them; they just sit there unused, preserved in case they're
 * needed later.
 *
 * `retarget_spins` is the only table this campaign needs: ONE row per
 * user_id, forever — no `day` key, because a user gets exactly castsPerDay
 * rolls ONCE, ever, not per day.
 *
 * `coin_credit_attempts` (from an earlier migration, still present) is
 * reused as-is for the at-most-once Coin API gate — it already only needs a
 * `day` value for bookkeeping, not for any gameplay logic.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.createTable('retarget_spins', {
    user_id: { type: 'text', notNull: true, primaryKey: true },
    casts_used: { type: 'integer', notNull: true, default: 0 },
    earned: { type: 'integer', notNull: true, default: 0 },
    redeemed_amount: { type: 'integer', notNull: true, default: 0 },
    // Snapshot of how the user's guaranteed total splits across their rolls,
    // fixed at first contact so retries/refreshes cannot re-roll it.
    reward_plan: { type: 'jsonb', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('retarget_spins', 'retarget_spins_casts_nonneg', {
    check: 'casts_used >= 0',
  });
  pgm.addConstraint('retarget_spins', 'retarget_spins_earned_nonneg', {
    check: 'earned >= 0',
  });
  pgm.addConstraint('retarget_spins', 'retarget_spins_redeemed_nonneg', {
    check: 'redeemed_amount >= 0',
  });
};

exports.down = (pgm) => {
  pgm.dropTable('retarget_spins');
};
