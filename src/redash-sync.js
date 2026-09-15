// Redash wallet-balance sync.
//
// Polls a saved Redash query every 5 minutes and mirrors its full result set
// into our own `redash_wallet_sync` table, so request-path code never
// depends on Redash's latency or availability — it only ever reads our own
// DB, at most 5 minutes stale.
//
// Concurrency: an advisory transaction lock serializes the refresh across
// any number of pods; whoever grabs it does the fetch + replace, everyone
// else is a no-op for that tick.
import { withTx } from './db.js';

const REDASH_LOCK_KEY = 'daily-cast-redash-wallet-sync';

function redashUrl() {
  const host = process.env.REDASH_HOST;
  const queryId = process.env.REDASH_QUERY_ID;
  const apiKey = process.env.REDASH_API_KEY;
  if (!host || !queryId || !apiKey) return null;
  return `${host.replace(/\/$/, '')}/api/queries/${queryId}/results.json?api_key=${apiKey}`;
}

export function redashSyncEnabled() {
  return Boolean(redashUrl());
}

async function fetchRows() {
  const url = redashUrl();
  if (!url) throw new Error('REDASH_HOST/REDASH_QUERY_ID/REDASH_API_KEY not configured');
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`redash: HTTP ${res.status}`);
  const body = await res.json();
  const rows = body?.query_result?.data?.rows;
  if (!Array.isArray(rows)) throw new Error('redash: unexpected response shape');
  return rows;
}

function normalizeRow(row) {
  const userId = row.user_id != null ? String(row.user_id) : null;
  const balance = Number(row.current_wallet_balance);
  if (!userId || !Number.isFinite(balance)) return null;
  return { userId, balance };
}

// Fetch happens BEFORE the transaction — Redash can be slow and must not
// hold a DB lock while it thinks.
export async function syncRedashWalletData() {
  const rows = (await fetchRows()).map(normalizeRow).filter(Boolean);

  await withTx(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [REDASH_LOCK_KEY]);
    await client.query('DELETE FROM redash_wallet_sync');
    await client.query(
      `INSERT INTO redash_wallet_sync (user_id, current_wallet_balance)
       SELECT * FROM unnest($1::text[], $2::numeric[])`,
      [rows.map((r) => r.userId), rows.map((r) => r.balance)],
    );
  });

  console.log(`[redash-sync] refreshed ${rows.length} row(s)`);
  return rows.length;
}
