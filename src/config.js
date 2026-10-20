// Loads the experiment config. All user-visible "content" strings live in
// config so the experiment owner can re-content and A/B (casts per day,
// wallet-balance reward tiers, cap, copy) without touching logic.
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
  if (!Number.isInteger(raw.rewardCapPerDay) || raw.rewardCapPerDay < 0) {
    throw new Error('config: rewardCapPerDay must be a non-negative integer');
  }
  const tiers = raw.walletTiers?.tiers;
  if (!Array.isArray(tiers) || tiers.length < 1 ||
      tiers.some((t) =>
        !Array.isArray(t.rewards) || t.rewards.length !== raw.castsPerDay ||
        t.rewards.some((g) => !Number.isInteger(g) || g < 0))) {
    throw new Error(`config: walletTiers.tiers must be a non-empty array of tiers with ${raw.castsPerDay}-integer rewards`);
  }
  // Ascending maxBalance, last tier open-ended (null) so every balance lands somewhere.
  const bounds = tiers.map((t) => t.maxBalance);
  if (bounds.at(-1) !== null ||
      bounds.slice(0, -1).some((b, i) => !Number.isFinite(b) || (i > 0 && b <= bounds[i - 1]))) {
    throw new Error('config: walletTiers.tiers maxBalance must be ascending numbers, with the last tier null');
  }

  cached = raw;
  return cached;
}
