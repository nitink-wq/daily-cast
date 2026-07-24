/**
 * Lifetime reward budget + zero-on-redeem.
 *
 * - `redeemed_amount` preserves what a claim paid out after `earned` is reset
 *   to 0 (the PM wants the visible balance to drop to zero once redeemed).
 *   Lifetime winnings are therefore SUM(earned + redeemed_amount) across a
 *   user's day rows — expired unredeemed coins still count against the
 *   lifetime budget, redeemed ones aren't lost when earned is zeroed.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.addColumn('user_daily_states', {
    redeemed_amount: { type: 'integer' },
  });
};

exports.down = (pgm) => {
  pgm.dropColumn('user_daily_states', 'redeemed_amount');
};
