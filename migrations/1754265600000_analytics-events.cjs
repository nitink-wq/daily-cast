/**
 * Client analytics events (tap_* / viewed_* per the org FE_Analytics
 * convention). One row per event; user_id and day are the super properties —
 * day is stamped SERVER-side (product day, IST) so the client can't spoof it.
 * `source` answers "from where" (cast_card, result_overlay, ledger,
 * sticky_bar, page_load); anything extra rides in props.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.createTable('analytics_events', {
    id: { type: 'bigserial', primaryKey: true },
    event_name: { type: 'text', notNull: true },
    user_id: { type: 'text', notNull: true },
    day: { type: 'date', notNull: true },
    screen_name: { type: 'text', notNull: true, default: 'daily_dice_screen' },
    // tap | screen_view
    event_type: { type: 'text', notNull: true, default: 'tap' },
    source: { type: 'text' },
    props: { type: 'jsonb', notNull: true, default: '{}' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  // Daily rollups per event, and a user's action trail.
  pgm.createIndex('analytics_events', ['event_name', 'day']);
  pgm.createIndex('analytics_events', ['user_id', 'day']);
};

exports.down = (pgm) => {
  pgm.dropTable('analytics_events');
};
