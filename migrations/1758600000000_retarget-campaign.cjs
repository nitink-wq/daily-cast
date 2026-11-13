/**
 * Retarget campaign: a one-time link, not a daily surface.
 *
 * By this point (after 1757600000000_remove-insight-persistent-wallet and
 * 1757700000000_redash-wallet-sync) content_pool_* is already gone,
 * user_daily_states/redemptions hold the old per-day wallet model, and
 * redash_wallet_sync mirrors the booking-gate sync. None of that fits here:
 * this campaign gives each user exactly castsPerDay rolls ONCE, ever — no
 * daily reset, no booking gate — so it needs no `day` key and no Redash
 * mirror at all. Drop all three and replace with `retarget_spins`: ONE row
 * per user_id, forever.
 *
 * `coin_credit_attempts` is reused as-is for the at-most-once Coin API gate
 * — it already only needs a `day` value for bookkeeping, not for any
 * gameplay logic.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.dropTable('redemptions');
  pgm.dropTable('user_daily_states');
  pgm.dropTable('redash_wallet_sync');

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

// Deliberately asymmetric: this branch's whole point is to retire the old
// per-day wallet model, not coexist with it. `down` restores the SHAPE left
// by 1757600000000 (persistent wallet, no selections/content-pool columns)
// but does not attempt to resurrect any data that was in retarget_spins.
exports.down = (pgm) => {
  pgm.dropTable('retarget_spins');

  pgm.createTable('user_daily_states', {
    user_id: { type: 'text', notNull: true },
    day: { type: 'date', notNull: true },
    casts_used: { type: 'integer', notNull: true, default: 0 },
    earned: { type: 'integer', notNull: true, default: 0 },
    reward_plan: { type: 'jsonb', notNull: true },
    redeemed_amount: { type: 'integer', notNull: true, default: 0 },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('user_daily_states', 'user_daily_states_pkey', {
    primaryKey: ['user_id', 'day'],
  });
  pgm.addConstraint('user_daily_states', 'user_daily_states_casts_nonneg', {
    check: 'casts_used >= 0',
  });
  pgm.addConstraint('user_daily_states', 'user_daily_states_earned_nonneg', {
    check: 'earned >= 0',
  });

  pgm.createTable('redemptions', {
    id: { type: 'bigserial', primaryKey: true },
    user_id: { type: 'text', notNull: true },
    amount: { type: 'integer', notNull: true },
    idempotency_key: { type: 'text', notNull: true, unique: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('redemptions', ['user_id']);

  pgm.createTable('redash_wallet_sync', {
    user_id: { type: 'text', notNull: true, primaryKey: true },
    current_wallet_balance: { type: 'numeric', notNull: true },
    synced_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
};
