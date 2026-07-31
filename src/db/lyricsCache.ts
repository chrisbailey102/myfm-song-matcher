import { exec, now, query, queryOne } from "./index.js";
import type { TimedLine } from "../lrclib.js";

export type LyricsCacheRow = {
  spotify_id: string;
  artist: string | null;
  title: string | null;
  source: string;
  plain_text: string;
  timed_json: string | null;
  fetched_at: number;
};

export async function getLyricsCache(
  spotifyId: string,
): Promise<LyricsCacheRow | null> {
  return queryOne<LyricsCacheRow>(
    `SELECT * FROM lyrics_cache WHERE spotify_id = $1`,
    [spotifyId],
  );
}

export async function upsertLyricsCache(input: {
  spotify_id: string;
  artist: string;
  title: string;
  source: string;
  plain_text: string;
  timed_lines: TimedLine[];
}): Promise<void> {
  const timed_json =
    input.timed_lines.length > 0 ? JSON.stringify(input.timed_lines) : null;
  await exec(
    `INSERT INTO lyrics_cache (spotify_id, artist, title, source, plain_text, timed_json, fetched_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (spotify_id) DO UPDATE SET
       artist = EXCLUDED.artist,
       title = EXCLUDED.title,
       source = EXCLUDED.source,
       plain_text = EXCLUDED.plain_text,
       timed_json = EXCLUDED.timed_json,
       fetched_at = EXCLUDED.fetched_at`,
    [
      input.spotify_id,
      input.artist,
      input.title,
      input.source,
      input.plain_text,
      timed_json,
      now(),
    ],
  );
}

export function parseTimedJson(raw: string | null): TimedLine[] {
  if (!raw) return [];
  try {
    return JSON.parse(raw) as TimedLine[];
  } catch {
    return [];
  }
}

export async function listLyricsForSpotifyIds(
  ids: string[],
): Promise<Map<string, LyricsCacheRow>> {
  const out = new Map<string, LyricsCacheRow>();
  if (!ids.length) return out;
  const rows = await query<LyricsCacheRow>(
    `SELECT * FROM lyrics_cache WHERE spotify_id = ANY($1::text[])`,
    [ids],
  );
  for (const r of rows) out.set(r.spotify_id, r);
  return out;
}

export type LyricSearchHit = {
  spotify_id: string;
  artist: string;
  title: string;
  source: string;
  snippet: string;
  match_ms: number | null;
  tempo: number | null;
  camelot: string;
};

/** Case-insensitive lyric search across a project's cached lyrics. */
export async function searchProjectLyrics(
  projectId: string,
  q: string,
  limit = 40,
): Promise<LyricSearchHit[]> {
  const needle = q.trim();
  if (needle.length < 2) return [];
  const rows = await query<{
    spotify_id: string;
    artist: string;
    title: string;
    source: string;
    plain_text: string;
    timed_json: string | null;
    tempo: number | null;
    tempo_override: number | null;
    camelot: string | null;
    camelot_override: string | null;
  }>(
    `SELECT l.spotify_id, s.artist, s.title, l.source, l.plain_text, l.timed_json,
            s.tempo, s.tempo_override, s.camelot, s.camelot_override
     FROM lyrics_cache l
     INNER JOIN songs s ON s.spotify_id_resolved = l.spotify_id
     WHERE s.project_id = $1
       AND l.plain_text ILIKE '%' || $2 || '%'
     ORDER BY s.artist, s.title
     LIMIT $3`,
    [projectId, needle, limit],
  );

  const lower = needle.toLowerCase();
  return rows.map((r) => {
    const text = r.plain_text;
    const idx = text.toLowerCase().indexOf(lower);
    const start = Math.max(0, idx - 40);
    const end = Math.min(text.length, idx + needle.length + 60);
    let snippet = text.slice(start, end).replace(/\s+/g, " ").trim();
    if (start > 0) snippet = "…" + snippet;
    if (end < text.length) snippet = snippet + "…";

    let match_ms: number | null = null;
    const timed = parseTimedJson(r.timed_json);
    for (const line of timed) {
      if (line.text.toLowerCase().includes(lower)) {
        match_ms = line.startMs;
        break;
      }
    }
    const tempoRaw =
      r.tempo_override != null && Number(r.tempo_override) > 0
        ? Number(r.tempo_override)
        : Number(r.tempo) || 0;
    const camelot = String(r.camelot_override || r.camelot || "").trim();
    return {
      spotify_id: r.spotify_id,
      artist: r.artist,
      title: r.title,
      source: r.source,
      snippet,
      match_ms,
      tempo: tempoRaw > 0 ? tempoRaw : null,
      camelot,
    };
  });
}
