/**
 * Initial schema for the Daily Cast surface.
 *
 * Managed by node-pg-migrate (the standard migration tool for node-postgres).
 * Applied migrations are recorded in the `pgmigrations` table, so each
 * migration runs exactly once per database no matter how many times the
 * deploy job executes or how many pods are running.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  // One row per product day (IST). Holds the shared "day anchor" shown to
  // every user that day.
  pgm.createTable('content_pool_days', {
    day: { type: 'date', primaryKey: true },
    anchor: { type: 'jsonb', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  // The day's AI-generated content pool: N small items with stable ids 1..N,
  // partitioned by chapter_index so a user's chapters can never collide on
  // the same item (each chapter draws from its own slice).
  pgm.createTable('content_pool_items', {
    day: { type: 'date', notNull: true, references: 'content_pool_days', onDelete: 'CASCADE' },
    item_id: { type: 'integer', notNull: true },
    chapter_index: { type: 'integer', notNull: true },
    body: { type: 'text', notNull: true },
    open_question: { type: 'text' }, // only set on open-loop-chapter items
  });
  pgm.addConstraint('content_pool_items', 'content_pool_items_pkey', {
    primaryKey: ['day', 'item_id'],
  });
  pgm.createIndex('content_pool_items', ['day', 'chapter_index']);

  // The authoritative per-user per-day record (brief §10): attempts,
  // unredeemed earnings, the day's persisted content selection, and
  // redemption state. Everything reward-bearing keys off this row under
  // SELECT ... FOR UPDATE, so it is safe across many pods.
  pgm.createTable('user_daily_states', {
    user_id: { type: 'text', notNull: true },
    day: { type: 'date', notNull: true },
    casts_used: { type: 'integer', notNull: true, default: 0 },
    earned: { type: 'integer', notNull: true, default: 0 },
    // Snapshot of how the capped daily total splits across casts, fixed at
    // first contact so retries/refreshes cannot re-roll the reward.
    reward_plan: { type: 'jsonb', notNull: true },
    // Ordered list of { cast, chapterIndex, itemId, roll, reward } — the
    // persisted selection that makes the day's reading stable across visits.
    selections: { type: 'jsonb', notNull: true, default: pgm.func(`'[]'::jsonb`) },
    redeem_ref: { type: 'text' },
    redeemed_at: { type: 'timestamptz' },
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

  // Ledger written by the (stub) Coin API adapter. The unique idempotency
  // key is what makes redeem double-tap / retry safe end to end.
  pgm.createTable('coin_credits', {
    id: 'bigserial',
    idempotency_key: { type: 'text', notNull: true, unique: true },
    user_id: { type: 'text', notNull: true },
    amount: { type: 'integer', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
};

exports.down = (pgm) => {
  pgm.dropTable('coin_credits');
  pgm.dropTable('user_daily_states');
  pgm.dropTable('content_pool_items');
  pgm.dropTable('content_pool_days');
};
