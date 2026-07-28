// Manual/CLI entry for publishing a day's content pool. The server now
// publishes the pool itself every night (see src/server.js), so this script
// is only needed for backfills and --force replacements.
//
//   npm run pool:generate                 # today (IST), no-op if it exists
//   npm run pool:generate -- --day=2026-07-30
//   npm run pool:generate -- --force      # replace, refused once users cast
import { loadConfig } from '../src/config.js';
import { todayKey } from '../src/day.js';
import { publishPool } from '../src/pool.js';
import { closePool } from '../src/db.js';

const force = process.argv.includes('--force');
const dayArg = process.argv.find((a) => a.startsWith('--day='));
const day = dayArg ? dayArg.split('=')[1] : todayKey();

try {
  const result = await publishPool(loadConfig(), day, { force });
  if (!result.published) {
    console.log(`[pool] pool for ${day} already exists — nothing to do`);
  }
} catch (err) {
  console.error('[pool] failed:', err.message);
  process.exitCode = 1;
} finally {
  await closePool().catch(() => {});
}
