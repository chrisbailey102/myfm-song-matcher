/**
 * Clean Genius / scraped lyric text before scoring.
 * Prefer chorus/hook sections when labelled; strip annotations and site junk.
 */

const NOISE_PHRASES = [
  "read more",
  "embed",
  "share",
  "contributors",
  "translations",
  "you might also like",
  "see also",
  "lyrics",
  "best song",
];

export function stripGeniusNoise(raw: string): string {
  let s = raw;
  // Remove [Verse]/ [Chorus] tags content keep text after
  s = s.replace(/\[[^\]]*\]/g, "\n");
  // Drop "N Contributors…" / "Translations…" lead-in often glued to lyrics
  s = s.replace(/^\s*\d+\s+Contributors[\s\S]*?Lyrics\s*/i, "");
  s = s.replace(/^\s*Translations[\s\S]*?Lyrics\s*/i, "");
  // Drop lines that are mostly site chrome
  const lines = s.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  const cleaned = lines.filter((line) => {
    const lower = line.toLowerCase();
    if (NOISE_PHRASES.some((p) => lower === p || lower.includes(p) && line.length < 40)) {
      return false;
    }
    if (/^\d+\s+contributors/i.test(line)) return false;
    if (/^embed$/i.test(line)) return false;
    return true;
  });
  return cleaned.join("\n");
}

/** Prefer [Chorus]/ [Hook]/ [Refrain] blocks when Genius tags exist; else full cleaned text */
export function extractHookFocusedLyrics(raw: string): string {
  const tagged = [...raw.matchAll(/\[(Chorus|Hook|Refrain|Post-Chorus)[^\]]*\]([\s\S]*?)(?=\n\[|$)/gi)];
  if (tagged.length >= 1) {
    const hooks = tagged.map((m) => m[2].trim()).filter(Boolean);
    if (hooks.join("\n").length > 40) {
      return stripGeniusNoise(hooks.join("\n\n"));
    }
  }
  return stripGeniusNoise(raw);
}

export function parseLrcLines(
  synced: string,
): Array<{ startMs: number; text: string }> {
  const out: Array<{ startMs: number; text: string }> = [];
  for (const line of synced.split(/\n+/)) {
    const m = /^\[(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?\]\s*(.*)$/.exec(line.trim());
    if (!m) continue;
    const min = Number(m[1]);
    const sec = Number(m[2]);
    const frac = m[3] ? Number(m[3].padEnd(3, "0")) : 0;
    const startMs = min * 60_000 + sec * 1000 + frac;
    const text = m[4].trim();
    if (!text) continue;
    out.push({ startMs, text });
  }
  return out;
}

export function formatMs(ms: number): string {
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${m}:${String(s).padStart(2, "0")}`;
}
