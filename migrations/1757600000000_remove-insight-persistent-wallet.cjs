/**
 * Removes the insight/content-pool feature (no more Gemini, no more daily
 * reading chapters) and switches redemption from same-day-only to a
 * persistent wallet: coins won on any day stay in `earned` until the user
 * redeems, instead of expiring at day rollover.
 *
 * `redemptions` records each wallet-level redeem action (spans any number
 * of day-rows) so its `idempotency_key` can gate the at-most-once external
 * Coin API call, the same way the old per-day `redeem_ref` did.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.dropTable('content_pool_items');
  pgm.dropTable('content_pool_days');

  pgm.dropColumn('user_daily_states', ['selections', 'redeem_ref', 'redeemed_at']);
  // Backfill existing NULLs (redeemed_amount was nullable) before locking in NOT NULL.
  pgm.sql('UPDATE user_daily_states SET redeemed_amount = 0 WHERE redeemed_amount IS NULL');
  pgm.alterColumn('user_daily_states', 'redeemed_amount', { notNull: true, default: 0 });

  pgm.createTable('redemptions', {
    id: { type: 'bigserial', primaryKey: true },
    user_id: { type: 'text', notNull: true },
    amount: { type: 'integer', notNull: true },
    idempotency_key: { type: 'text', notNull: true, unique: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('redemptions', ['user_id']);
};

exports.down = (pgm) => {
  pgm.dropTable('redemptions');

  pgm.alterColumn('user_daily_states', 'redeemed_amount', { notNull: false, default: null });
  pgm.addColumn('user_daily_states', {
    selections: { type: 'jsonb', notNull: true, default: pgm.func(`'[]'::jsonb`) },
    redeem_ref: { type: 'text' },
    redeemed_at: { type: 'timestamptz' },
  });

  pgm.createTable('content_pool_days', {
    day: { type: 'date', primaryKey: true },
    anchor: { type: 'jsonb', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createTable('content_pool_items', {
    day: { type: 'date', notNull: true, references: 'content_pool_days', onDelete: 'CASCADE' },
    item_id: { type: 'integer', notNull: true },
    chapter_index: { type: 'integer', notNull: true },
    body: { type: 'text', notNull: true },
    open_question: { type: 'text' },
  });
  pgm.addConstraint('content_pool_items', 'content_pool_items_pkey', {
    primaryKey: ['day', 'item_id'],
  });
  pgm.createIndex('content_pool_items', ['day', 'chapter_index']);
};
