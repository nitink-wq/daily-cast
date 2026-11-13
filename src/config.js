// Loads the experiment config. All user-visible "content" strings live in
// config so the experiment owner can re-content and A/B (rolls per user,
// guaranteed reward totals, copy) without touching logic. This is a
// ONE-TIME retarget campaign — there is no daily reset, so unlike the
// original daily-cast config there is no reward *schedule* here, just a
// fixed set of totals one of which every user is guaranteed exactly once.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH =
  process.env.EXPERIMENT_CONFIG_PATH ||
  path.join(__dirname, '..', 'config', 'experiment.config.json');

let cached = null;

export function loadConfig() {
  if (cached) return cached;
  const raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));

  // Minimal structural validation — fail loudly at boot, not mid-request.
  if (!Number.isInteger(raw.castsPerDay) || raw.castsPerDay < 1) {
    throw new Error('config: castsPerDay must be a positive integer');
  }
  const rt = raw.retarget;
  if (!rt || !Array.isArray(rt.totalRewardOptions) || rt.totalRewardOptions.length === 0 ||
      rt.totalRewardOptions.some((g) => !Number.isInteger(g) || g <= 0)) {
    throw new Error('config: retarget.totalRewardOptions must be a non-empty array of positive integers');
  }

  cached = raw;
  return cached;
}
