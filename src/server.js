// Thin HTTP layer. Pods are fully stateless — all state lives in Postgres —
// so this scales horizontally in Kubernetes with no coordination.
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { healthcheck, closePool, query } from './db.js';
import { todayKey } from './day.js';
import { ensurePoolForToday } from './pool.js';
import { getSession, cast, claim, isValidUserId, StateError } from './state.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const cfg = loadConfig(); // fail fast at boot on a broken config

app.disable('x-powered-by');
app.use(express.json({ limit: '4kb' }));
app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: '5m' }));

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
  POOL_MISSING: 503,
};

function requireUser(req) {
  const userId = req.method === 'GET' ? req.query.user_id : req.body?.user_id;
  if (!userId) throw new StateError('NO_USER', 'user_id required');
  if (!isValidUserId(userId)) throw new StateError('INVALID_USER', 'malformed user_id');
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

// Self-healing pool: if the nightly pass hasn't produced today's pool yet
// (pod restart, first request just after midnight IST), publish it on demand.
// Failures are logged and swallowed — the state layer then raises the usual
// POOL_MISSING so the client shows the retryable error card.
function ensurePool() {
  return ensurePoolForToday(cfg).catch((err) => {
    console.error('[pool] on-demand publish failed:', err.message);
  });
}

// --- API -------------------------------------------------------------------
app.get('/api/session', async (req, res) => {
  try {
    const userId = requireUser(req);
    await ensurePool();
    res.json(await getSession(userId));
  } catch (err) {
    sendError(res, err);
  }
});

app.post('/api/cast', async (req, res) => {
  try {
    const userId = requireUser(req);
    await ensurePool();
    res.json(await cast(userId));
  } catch (err) {
    sendError(res, err);
  }
});

app.post('/api/claim', async (req, res) => {
  try {
    const userId = requireUser(req);
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
  'tap_talk_to_astro',
  'tap_back',
]);

app.post('/api/track', async (req, res) => {
  res.status(204).end();
  try {
    const { user_id: uid, event, source, props } = req.body || {};
    if (!isValidUserId(uid) || !TRACK_EVENTS.has(event)) return;
    const safeProps = props && typeof props === 'object' && !Array.isArray(props) ? props : {};
    await query(
      `INSERT INTO analytics_events (event_name, user_id, day, screen_name, event_type, source, props)
       VALUES ($1, $2, $3, 'daily_dice_screen', $4, $5, $6)`,
      [event, uid, todayKey(),
       event.startsWith('viewed_') ? 'screen_view' : 'tap',
       typeof source === 'string' && source ? source.slice(0, 64) : null,
       JSON.stringify(safeProps)],
    );
  } catch (err) {
    console.error('[track] failed', err.message);
  }
});

// --- boot / graceful shutdown ---------------------------------------------
const port = Number(process.env.PORT || 3000);
const server = app.listen(port, () => {
  console.log(`[daily-cast] listening on :${port}`);
});

// Built-in nightly generation (replaces the external CronJob): publish
// today's pool at boot, then re-check every 5 minutes so the new day's pool
// (Gemini-generated when GEMINI_API_KEY is set) appears within minutes of
// midnight IST. ensurePoolForToday() is a free in-memory check once the
// day's pool exists, and is multi-pod safe via an advisory lock.
ensurePool();
setInterval(ensurePool, 5 * 60 * 1000).unref();

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
