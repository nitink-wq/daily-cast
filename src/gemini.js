// Daily reading generation via Google Gemini (REST, no SDK needed).
//
// Entirely optional: when GEMINI_API_KEY is unset or the call fails for any
// reason, the pool falls back to the sampleVariants in the experiment config,
// so a bad key, quota error or outage can never take the page down.
const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const VARIANTS_PER_CHAPTER = 8;
const TIMEOUT_MS = 90_000;

export function geminiEnabled() {
  return Boolean(process.env.GEMINI_API_KEY);
}

function buildPrompt(cfg, day, weekday, anchor) {
  const openLoop = cfg.chapters.find((c) => c.openLoop);
  const chapterList = cfg.chapters
    .map((c, i) => `${i + 1}. "${c.label}"${c.openLoop ? ' (open-loop chapter, see rule below)' : ''}`)
    .join('\n');
  const examples = cfg.chapters
    .map((c) => {
      const sample = c.sampleVariants.slice(0, 2)
        .map((v) => `  - ${JSON.stringify(v)}`)
        .join('\n');
      return `Chapter "${c.label}":\n${sample}`;
    })
    .join('\n');

  return `You write short daily astrology readings for AstroLokal, an Indian astrology app.
Audience: tier-2/tier-3 Indian users. Use very simple everyday English (grade-6 level).

Today is ${day}, a ${weekday}. Day anchor: ${anchor.label} — ${anchor.detail}

Write exactly ${VARIANTS_PER_CHAPTER} fresh variants for EACH of these chapters, in this order:
${chapterList}

Rules:
- 1–2 short sentences per variant, at most ~40 words. No emojis, no hashtags.
- Vedic flavour is welcome (Chandra, Surya, Budh, Shukra, Shani, Mangal, Brihaspati); prefer today's ruling planet where it fits naturally.
- Keep advice safe and gentle: no medical or legal claims, no guaranteed money, never name specific people.
- Every variant in a chapter must feel clearly different from the others.
- Chapter "${openLoop.label}" is the open-loop chapter: every variant must end on something the dice CANNOT reveal, and must include an "openQuestion" field — the question a full astrologer consultation would answer.

Match the voice of these examples:
${examples}

Return ONLY valid JSON, exactly this shape (chapter order preserved, ${VARIANTS_PER_CHAPTER} items per chapter; "openQuestion" only in the open-loop chapter):
{"chapters": [[{"body": "..."}], [{"body": "..."}], [{"body": "...", "openQuestion": "..."}]]}`;
}

function validateChapters(parsed, cfg) {
  const chapters = parsed?.chapters;
  if (!Array.isArray(chapters) || chapters.length !== cfg.chapters.length) {
    throw new Error(`expected ${cfg.chapters.length} chapter arrays`);
  }
  return chapters.map((items, index) => {
    const spec = cfg.chapters[index];
    if (!Array.isArray(items) || items.length < 4) {
      throw new Error(`chapter ${index}: need at least 4 variants, got ${Array.isArray(items) ? items.length : 'none'}`);
    }
    return items.slice(0, VARIANTS_PER_CHAPTER).map((item, i) => {
      const body = typeof item?.body === 'string' ? item.body.trim() : '';
      if (body.length < 20 || body.length > 400) {
        throw new Error(`chapter ${index} item ${i}: body missing or wrong length`);
      }
      if (!spec.openLoop) return { body };
      const openQuestion = typeof item?.openQuestion === 'string' ? item.openQuestion.trim() : '';
      if (openQuestion.length < 10) {
        throw new Error(`chapter ${index} item ${i}: openQuestion required on open-loop chapter`);
      }
      return { body, openQuestion };
    });
  });
}

// Returns per-chapter arrays of { body, openQuestion? }. Throws on any
// problem — the caller decides the fallback.
export async function generateChaptersWithGemini(cfg, day, weekday, anchor) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-goog-api-key': process.env.GEMINI_API_KEY,
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: buildPrompt(cfg, day, weekday, anchor) }] }],
        generationConfig: { temperature: 0.9, responseMimeType: 'application/json' },
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    },
  );
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 300);
    throw new Error(`Gemini HTTP ${res.status}: ${detail}`);
  }
  const data = await res.json();
  const text = (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
  if (!text) throw new Error('Gemini returned no text');
  return validateChapters(JSON.parse(text), cfg);
}
