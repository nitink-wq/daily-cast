// Thin HTTP layer. Pods are fully stateless — all state lives in Postgres —
// so this scales horizontally in Kubernetes with no coordination.
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { healthcheck, closePool } from './db.js';
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

// --- API -------------------------------------------------------------------
app.get('/api/session', async (req, res) => {
  try {
    const userId = requireUser(req);
    res.json(await getSession(userId));
  } catch (err) {
    sendError(res, err);
  }
});

app.post('/api/cast', async (req, res) => {
  try {
    const userId = requireUser(req);
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
