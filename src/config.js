// Loads the experiment config. All user-visible "content" strings live in
// config so the experiment owner can re-content and A/B (casts per day,
// reward schedule, cap, copy) without touching logic.
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
  const lr = raw.lifetimeReward;
  if (!lr || !Number.isInteger(lr.totalBudget) || lr.totalBudget <= 0) {
    throw new Error('config: lifetimeReward.totalBudget must be a positive integer');
  }
  if (!Array.isArray(lr.rewardSchedule) || lr.rewardSchedule.length < 1 ||
      lr.rewardSchedule.some((day) =>
        !Array.isArray(day) || day.length !== raw.castsPerDay ||
        day.some((g) => !Number.isInteger(g) || g < 0))) {
    throw new Error(`config: lifetimeReward.rewardSchedule must be a non-empty array of ${raw.castsPerDay}-integer day plans`);
  }

  cached = raw;
  return cached;
}
