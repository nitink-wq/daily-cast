// Loads the experiment config. All user-visible "content" strings live in
// config (see the brief §6) so the experiment owner can re-content and A/B
// (chapter count, cap, split, copy) without touching logic.
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
  if (!Array.isArray(raw.chapters) || raw.chapters.length < 1) {
    throw new Error('config: chapters must be a non-empty array');
  }
  if (!Number.isInteger(raw.rewardCapPerDay) || raw.rewardCapPerDay < 0) {
    throw new Error('config: rewardCapPerDay must be a non-negative integer');
  }
  const lr = raw.lifetimeReward;
  if (!lr || !Number.isInteger(lr.totalBudget) || lr.totalBudget <= 0 ||
      !Number.isInteger(lr.minGrant) || lr.minGrant <= 0 ||
      !Array.isArray(lr.earlyDaySchedule) ||
      lr.earlyDaySchedule.some((g) => !Number.isInteger(g) || g < 0) ||
      typeof lr.laterWinChance !== 'number' || lr.laterWinChance < 0 || lr.laterWinChance > 1 ||
      !Array.isArray(lr.laterGrants) || lr.laterGrants.length === 0 ||
      lr.laterGrants.some((g) => !Number.isInteger(g) || g < lr.minGrant)) {
    throw new Error('config: lifetimeReward needs totalBudget, minGrant, earlyDaySchedule, laterWinChance (0..1), laterGrants (each >= minGrant)');
  }
  if (lr.firstDayPlan !== undefined &&
      (!Array.isArray(lr.firstDayPlan) || lr.firstDayPlan.length === 0 ||
       lr.firstDayPlan.some((g) => !Number.isInteger(g) || g < 0))) {
    throw new Error('config: lifetimeReward.firstDayPlan must be a non-empty array of non-negative integers');
  }
  const openLoopCount = raw.chapters.filter((c) => c.openLoop).length;
  if (openLoopCount !== 1) {
    throw new Error('config: exactly one chapter must be flagged openLoop');
  }
  raw.castsPerDay = raw.chapters.length;
  cached = raw;
  return cached;
}
