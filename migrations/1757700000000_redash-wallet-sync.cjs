/**
 * Mirror table for the Redash wallet-balance sync (src/redash-sync.js).
 * Fully replaced every 5 minutes by the poller — this table is a cache of
 * Redash's last-known result set, never written to by request-path code.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.createTable('redash_wallet_sync', {
    user_id: { type: 'text', notNull: true, primaryKey: true },
    current_wallet_balance: { type: 'numeric', notNull: true },
    synced_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
};

exports.down = (pgm) => {
  pgm.dropTable('redash_wallet_sync');
};
