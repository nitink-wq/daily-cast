// Daily content-pool job (brief §11).
//
// Runs once per day (Kubernetes CronJob in production, one-shot service in
// docker compose) and publishes the day's shared pool: ~20-30 small items
// with stable ids 1..N, partitioned across the chapter themes, plus the
// day's astro anchor.
//
// The AI generation step is a stub for now: it draws from the placeholder
// variant pools in the experiment config. Swap `generateItems` for a real
// model call without touching anything else — the storage shape and the
// serving path stay identical.
//
// Idempotent: if the day's pool already exists it exits 0 without changes
// (so re-runs and multi-pod races are harmless). Use --force to replace a
// day's pool — only safe before real users have cast that day.
import pg from 'pg';
import { loadConfig } from '../src/config.js';
import { todayKey, weekdayName } from '../src/day.js';

const force = process.argv.includes('--force');
const dayArg = process.argv.find((a) => a.startsWith('--day='));
const day = dayArg ? dayArg.split('=')[1] : todayKey();

// --- AI hook ---------------------------------------------------------------
// Replace this with the real once-a-day AI generation. It must return, for
// each chapter index, an array of { body, openQuestion? } items (openQuestion
// required for the open-loop chapter).
function generateItems(cfg) {
  return cfg.chapters.map((chapter) => chapter.sampleVariants);
}

function buildAnchor(cfg) {
  const weekday = weekdayName(new Date(`${day}T12:00:00+05:30`));
  return cfg.anchorsByWeekday[weekday] || { label: weekday, detail: '' };
}

async function main() {
  const cfg = loadConfig();
  const client = new pg.Client({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.PGSSL === 'require' ? { rejectUnauthorized: false } : undefined,
  });
  await client.connect();

  try {
    await client.query('BEGIN');

    const existing = await client.query(
      'SELECT 1 FROM content_pool_days WHERE day = $1 FOR UPDATE',
      [day],
    );
    if (existing.rowCount > 0) {
      if (!force) {
        console.log(`[pool] pool for ${day} already exists — nothing to do`);
        await client.query('COMMIT');
        return;
      }
      const used = await client.query(
        'SELECT count(*)::int AS n FROM user_daily_states WHERE day = $1 AND casts_used > 0',
        [day],
      );
      if (used.rows[0].n > 0) {
        throw new Error(
          `refusing --force: ${used.rows[0].n} user(s) already cast on ${day}; replacing the pool would break their stable readings`,
        );
      }
      await client.query('DELETE FROM content_pool_days WHERE day = $1', [day]);
      console.log(`[pool] --force: replaced existing (unused) pool for ${day}`);
    }

    await client.query(
      'INSERT INTO content_pool_days (day, anchor) VALUES ($1, $2)',
      [day, JSON.stringify(buildAnchor(cfg))],
    );

    const perChapter = generateItems(cfg);
    let itemId = 0;
    let total = 0;
    for (let chapterIndex = 0; chapterIndex < perChapter.length; chapterIndex++) {
      for (const variant of perChapter[chapterIndex]) {
        itemId += 1;
        total += 1;
        await client.query(
          `INSERT INTO content_pool_items (day, item_id, chapter_index, body, open_question)
           VALUES ($1, $2, $3, $4, $5)`,
          [day, itemId, chapterIndex, variant.body, variant.openQuestion ?? null],
        );
      }
    }

    await client.query('COMMIT');
    console.log(`[pool] published pool for ${day}: ${total} items across ${perChapter.length} chapters`);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('[pool] failed:', err.message);
  process.exit(1);
});
