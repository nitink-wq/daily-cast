// Thin HTTP layer. Pods are fully stateless — all state lives in Postgres —
// so this scales horizontally in Kubernetes with no coordination.
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { healthcheck, closePool, query } from './db.js';
import { todayKey } from './day.js';
import { getSession, cast, claim, isValidUserId, StateError } from './state.js';
import { syncRedashWalletData, redashSyncEnabled } from './redash-sync.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const cfg = loadConfig(); // fail fast at boot on a broken config

app.disable('x-powered-by');
app.use((req, res, next) => {
  // Baseline hardening headers. No CSP: the client is a single inline
  // <script>/<style> file with no external script sources to allowlist.
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer-when-downgrade');
  next();
});
app.use(express.json({ limit: '4kb' }));
app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: '5m' }));

// --- rate limiting -----------------------------------------------------
// In-memory fixed-window counters. This is a single-pod dev experiment, so
// an in-memory limiter is sufficient defense-in-depth against abuse/replay
// of a guessed user_id; it does NOT replace real authentication (see the
// user_id note below) and would need a shared store (Redis) to hold across
// multiple pods.
const rateBuckets = new Map();
function rateLimited(key, max, windowMs) {
  const now = Date.now();
  const bucket = rateBuckets.get(key);
  if (!bucket || now > bucket.resetAt) {
    rateBuckets.set(key, { count: 1, resetAt: now + windowMs });
    return false;
  }
  bucket.count += 1;
  return bucket.count > max;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of rateBuckets) if (now > v.resetAt) rateBuckets.delete(k);
}, 60_000).unref();

// --- health probes (Kubernetes liveness/readiness) -------------------------
app.get('/healthz', (req, res) => res.json({ ok: true }));
app.get('/readyz', async (req, res) => {
  try {
    await healthcheck();
    res.json({ ok: true });
  } catch {
    res.status(503).json({ ok: false });
  }
});

// --- helpers ---------------------------------------------------------------
const ERROR_STATUS = {
  NO_USER: 401,
  INVALID_USER: 400,
  EXHAUSTED: 409,
  NOTHING_TO_CLAIM: 409,
  CONFLICT: 409,
  RATE_LIMITED: 429,
};

function requireUser(req) {
  const userId = req.method === 'GET' ? req.query.user_id : req.body?.user_id;
  if (!userId) throw new StateError('NO_USER', 'user_id required');
  if (!isValidUserId(userId)) throw new StateError('INVALID_USER', 'malformed user_id');
  return userId;
}

// Per-user_id + per-route ceiling. Values are generous multiples of normal
// usage (3 casts/day, occasional claims) so real users never notice, while
// bounding how hard a guessed/leaked user_id can be hammered.
function requireUserRateLimited(req, route, max, windowMs) {
  const userId = requireUser(req);
  if (rateLimited(`${route}:${userId}`, max, windowMs)) {
    throw new StateError('RATE_LIMITED', 'too many requests');
  }
  return userId;
}

function sendError(res, err) {
  if (err instanceof StateError) {
    // Blocked/error copy comes from config so the client renders nothing
    // hardcoded even on failure paths.
    const copy = err.code === 'NO_USER' || err.code === 'INVALID_USER'
      ? cfg.copy.blocked
      : cfg.copy.error;
    return res.status(ERROR_STATUS[err.code] || 400).json({ error: err.code, copy });
  }
  console.error('[api] unexpected error', err);
  return res.status(500).json({ error: 'INTERNAL', copy: cfg.copy.error });
}

// --- API -------------------------------------------------------------------
app.get('/api/session', async (req, res) => {
  try {
    const userId = requireUserRateLimited(req, 'session', 60, 60_000);
    res.json(await getSession(userId));
  } catch (err) {
    sendError(res, err);
  }
});

app.post('/api/cast', async (req, res) => {
  try {
    const userId = requireUserRateLimited(req, 'cast', 20, 5 * 60_000);
    res.json(await cast(userId));
  } catch (err) {
    sendError(res, err);
  }
});

app.post('/api/claim', async (req, res) => {
  try {
    const userId = requireUserRateLimited(req, 'claim', 10, 5 * 60_000);
    res.json(await claim(userId));
  } catch (err) {
    sendError(res, err);
  }
});

// --- analytics ------------------------------------------------------------
// Fire-and-forget event sink (client uses sendBeacon). Responds 204 before
// the insert: analytics must never break or slow the product. Super
// properties user_id + day; day is stamped server-side (product day, IST) so
// the client can't spoof it.
const TRACK_EVENTS = new Set([
  'viewed_daily_dice',
  'tap_dice_roll',
  'tap_dice_roll_continue',
  'tap_redeem_coins',
  'tap_final_continue',
  'tap_back',
  'tap_back_home',
]);
// Only sources this client ever actually sends. sendBeacon requests are not
// subject to CORS preflight, so a third-party page could fire arbitrary
// no-cors beacons at this endpoint with a guessed user_id — this allowlist
// plus the rate limit below bound how much junk can land in analytics.
const TRACK_SOURCES = new Set(['page_load', 'header', 'footer', 'cast_card', 'result_overlay', 'ledger']);

app.post('/api/track', async (req, res) => {
  res.status(204).end();
  try {
    const { user_id: uid, event, source, props } = req.body || {};
    if (!isValidUserId(uid) || !TRACK_EVENTS.has(event)) return;
    if (rateLimited(`track:${uid}`, 120, 5 * 60_000)) return;
    const safeProps = props && typeof props === 'object' && !Array.isArray(props) ? props : {};
    await query(
      `INSERT INTO analytics_events (event_name, user_id, day, screen_name, event_type, source, props)
       VALUES ($1, $2, $3, 'daily_dice_screen', $4, $5, $6)`,
      [event, uid, todayKey(),
       event.startsWith('viewed_') ? 'screen_view' : 'tap',
       TRACK_SOURCES.has(source) ? source : null,
       JSON.stringify(safeProps)],
    );
  } catch (err) {
    console.error('[track] failed', err.message);
  }
});

// --- redash wallet-balance sync ---------------------------------------------
// Every 5 min, mirror the Redash query result into our own DB (see
// src/redash-sync.js). Optional: if the env vars aren't set (e.g. local
// dev), the sync is simply skipped rather than failing boot.
if (redashSyncEnabled()) {
  const runRedashSync = () => syncRedashWalletData().catch((err) => {
    console.error('[redash-sync] failed', err.message);
  });
  runRedashSync();
  setInterval(runRedashSync, 5 * 60 * 1000).unref();
} else {
  console.log('[redash-sync] REDASH_HOST/REDASH_QUERY_ID/REDASH_API_KEY not set — sync disabled');
}

// --- boot / graceful shutdown ---------------------------------------------
const port = Number(process.env.PORT || 3000);
const server = app.listen(port, () => {
  console.log(`[daily-cast] listening on :${port}`);
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    console.log(`[daily-cast] ${signal} received, shutting down`);
    server.close(async () => {
      await closePool().catch(() => {});
      process.exit(0);
    });
    // Hard exit if connections refuse to drain (k8s will SIGKILL anyway).
    setTimeout(() => process.exit(1), 10_000).unref();
  });
}
