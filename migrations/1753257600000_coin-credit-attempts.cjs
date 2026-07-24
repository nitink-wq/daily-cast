/**
 * At-most-once firing gate for the external Coin API.
 *
 * The real Coin API (POST /v1/system-transactions/) has NO idempotency of its
 * own — it credits on every call. This table is our gate: exactly one attempt
 * row may exist per user-day redemption (UNIQUE idempotency_key), inserted
 * BEFORE the HTTP call. A concurrent or repeated redeem loses the insert race
 * and never fires. Failed attempts are recorded but never auto-refired; rows
 * with status other than success/stub_credited are the reconciliation
 * worklist.
 *
 * Replaces the stub-only coin_credits ledger — in stub mode (no COIN_API_URL)
 * the attempt row itself is the credit record.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.createTable('coin_credit_attempts', {
    id: { type: 'bigserial', primaryKey: true },
    idempotency_key: { type: 'text', notNull: true, unique: true },
    user_id: { type: 'text', notNull: true },
    day: { type: 'date', notNull: true },
    amount: { type: 'integer', notNull: true },
    // firing | success | failed | error | stub_credited
    status: { type: 'text', notNull: true },
    http_status: { type: 'integer' },
    response: { type: 'jsonb' },
    error: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  // Ops/reconciliation: find attempts that fired but didn't succeed.
  pgm.createIndex('coin_credit_attempts', ['status', 'day']);

  pgm.dropTable('coin_credits');
};

exports.down = (pgm) => {
  pgm.createTable('coin_credits', {
    id: { type: 'bigserial', primaryKey: true },
    idempotency_key: { type: 'text', notNull: true, unique: true },
    user_id: { type: 'text', notNull: true },
    amount: { type: 'integer', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.dropTable('coin_credit_attempts');
};
