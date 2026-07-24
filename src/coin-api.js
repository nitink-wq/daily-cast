// Sealed Coin API adapter (brief §10.4).
//
// This module is the ONLY place wallet crediting happens, and it only ever
// runs server-side. The client never sees the endpoint, credentials, or
// amount — its "redeem" tap is just a signal; the server computes the amount
// from its own records and calls this.
//
// The real Coin API (POST {COIN_API_URL}, HTTP Basic auth, array body) has NO
// idempotency of its own — it credits on every call. At-most-once firing is
// enforced HERE: an attempt row with a UNIQUE idempotency key is inserted
// before the HTTP call, so concurrent/repeated redeems lose the insert race
// and are suppressed. A non-success attempt is recorded but never auto-refired
// (with a no-dedup API a blind retry risks double credit) — such rows are the
// reconciliation worklist, queryable by status.
//
// Modes:
//  - COIN_API_URL set   → fire the real API, at most once per user-day.
//  - COIN_API_URL unset → stub: the attempt row itself is the credit ledger.

import { query } from './db.js';
import { loadConfig } from './config.js';

export async function fireCoinCredit({ userId, day, amount, idempotencyKey }) {
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new Error('coin-api: amount must be a positive integer');
  }
  const live = Boolean(process.env.COIN_API_URL);

  // The gate: only the caller that wins this insert may fire.
  const gate = await query(
    `INSERT INTO coin_credit_attempts (idempotency_key, user_id, day, amount, status)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING id`,
    [idempotencyKey, userId, day, amount, live ? 'firing' : 'stub_credited'],
  );
  if (gate.rowCount === 0) return { fired: false, status: 'already_attempted' };
  if (!live) return { fired: true, status: 'stub_credited' };

  const tx = loadConfig().coinCredit || {};
  const auth = Buffer.from(
    `${process.env.COIN_API_USER || ''}:${process.env.COIN_API_PASS || ''}`,
  ).toString('base64');
  // Contract: array of transactions; userId is numeric on their side, amount
  // is a "10.00"-style string.
  const payload = [
    {
      userId: /^\d+$/.test(userId) ? Number(userId) : userId,
      amount: amount.toFixed(2),
      purpose: tx.purpose || 'daily_dice_reward',
      description: (tx.descriptionTemplate || 'Daily Dice winnings {day}').replace('{day}', day),
      source: tx.source || 'daily_cast',
    },
  ];

  let status = 'error';
  let httpStatus = null;
  let responseBody = null;
  let errorText = null;
  try {
    const res = await fetch(process.env.COIN_API_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Basic ${auth}` },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    });
    httpStatus = res.status;
    responseBody = await res.text().catch(() => null);
    status = res.ok ? 'success' : 'failed';
  } catch (err) {
    errorText = String((err && err.message) || err);
  }
  await query(
    `UPDATE coin_credit_attempts
        SET status = $2, http_status = $3, response = $4, error = $5, updated_at = now()
      WHERE idempotency_key = $1`,
    [
      idempotencyKey,
      status,
      httpStatus,
      responseBody != null ? JSON.stringify({ body: responseBody.slice(0, 2000) }) : null,
      errorText,
    ],
  );
  return { fired: true, status, httpStatus };
}
