import type { EnrichedSong, PairCandidate } from "./types.js";
import {
  harmonicComponent,
  isMikCompatible,
  keyRelationship,
  bpmClosenessScore,
} from "./camelot.js";
import { getBpmTolerance, getMaxPairs } from "./config.js";
import { scoreLyricPair } from "./lyrics.js";
import type { TimedLine } from "./lrclib.js";
import fs from "node:fs";
import path from "node:path";
import { stringify } from "csv-stringify/sync";

export type LyricBundle = {
  text: string;
  timed: TimedLine[];
};

export type PairFilters = {
  bpmTolerance?: number;
  minLyricScore?: number;
  minHarmonicScore?: number;
  requireBridge?: boolean;
  /** Single Camelot code or comma/space-separated list (e.g. "8A,8B"). */
  camelot?: string;
  yearMin?: number;
  yearMax?: number;
  maxResults?: number;
};

export type PairGenOptions = {
  /** Left side / seed songs (always from the active playlist/project) */
  seeds: EnrichedSong[];
  /**
   * Right side pool. Same as seeds for playlist-only;
   * library tracks (possibly excluding seeds) for expand-library.
   */
  pool: EnrichedSong[];
  /** spotify_id → lyrics */
  lyricsById?: Map<string, LyricBundle>;
  withLyrics: boolean;
  /** If true, only seed→pool directed pairs (no seed↔seed unless pool includes seeds) */
  directed?: boolean;
  filters?: PairFilters;
};

function yearOf(s: EnrichedSong): number | null {
  const y = Number(s.year);
  return Number.isFinite(y) ? y : null;
}

function parseCamelotFilter(raw: string): string[] {
  return raw
    .split(/[,\s]+/)
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
}

function passesSongFilters(s: EnrichedSong, f?: PairFilters): boolean {
  if (!f) return true;
  if (f.camelot) {
    const allowed = parseCamelotFilter(f.camelot);
    if (allowed.length) {
      const c = (s.camelot_override || s.camelot || "").toUpperCase();
      if (!allowed.includes(c)) return false;
    }
  }
  const y = yearOf(s);
  if (f.yearMin != null && y != null && y < f.yearMin) return false;
  if (f.yearMax != null && y != null && y > f.yearMax) return false;
  return true;
}

function scoreOnePair(
  a: EnrichedSong,
  b: EnrichedSong,
  withLyrics: boolean,
  lyricsById: Map<string, LyricBundle> | undefined,
  bpmTol: number,
): PairCandidate | null {
  if (!a.camelot || !b.camelot) return null;
  if (!a.tempo || !b.tempo) return null;
  const bpmDelta = Math.abs(a.tempo - b.tempo);
  if (bpmDelta > bpmTol) return null;
  if (!isMikCompatible(a.camelot, b.camelot)) return null;

  let lyricScore = 0;
  let bridges = "";
  let notes = "";
  if (withLyrics && lyricsById) {
    const la = lyricsById.get(a.spotify_id_resolved);
    const lb = lyricsById.get(b.spotify_id_resolved);
    if (la?.text && lb?.text) {
      const s = scoreLyricPair(la.text, lb.text, la.timed, lb.timed);
      lyricScore = s.score;
      bridges = s.bridges.join(" | ");
    } else {
      notes = "missing_lyrics_for_one_or_both";
    }
  }

  const harmonic = harmonicComponent(a.camelot, b.camelot, a.tempo, b.tempo);
  const combined = 0.62 * harmonic + 0.38 * lyricScore;

  return {
    song_a_artist: a.artist,
    song_a_title: a.title,
    song_a_spotify_id: a.spotify_id_resolved,
    song_b_artist: b.artist,
    song_b_title: b.title,
    song_b_spotify_id: b.spotify_id_resolved,
    bpm_a: a.tempo,
    bpm_b: b.tempo,
    bpm_delta: bpmDelta,
    camelot_a: a.camelot,
    camelot_b: b.camelot,
    key_relationship: keyRelationship(a.camelot, b.camelot),
    harmonic_score: harmonic,
    lyric_score: lyricScore,
    bridge_phrases: bridges,
    notes:
      notes ||
      `combined=${combined.toFixed(3)};bpm_closeness=${bpmClosenessScore(a.tempo, b.tempo, bpmTol).toFixed(3)}`,
  };
}

export function generatePairCandidates(opts: PairGenOptions): PairCandidate[] {
  const {
    seeds,
    pool,
    lyricsById,
    withLyrics,
    directed = false,
    filters,
  } = opts;
  const maxPairs = filters?.maxResults ?? getMaxPairs();
  const bpmTol = filters?.bpmTolerance ?? getBpmTolerance();
  const out: PairCandidate[] = [];
  const seen = new Set<string>();

  const seedList = seeds.filter((s) => passesSongFilters(s, filters));
  const poolList = pool.filter((s) => passesSongFilters(s, filters));

  const push = (a: EnrichedSong, b: EnrichedSong) => {
    if (a.spotify_id_resolved === b.spotify_id_resolved) return;
    const key = [a.spotify_id_resolved, b.spotify_id_resolved].sort().join("|");
    if (!directed && seen.has(key)) return;
    if (directed) {
      const dkey = `${a.spotify_id_resolved}>${b.spotify_id_resolved}`;
      if (seen.has(dkey)) return;
      seen.add(dkey);
    } else {
      seen.add(key);
    }
    const pair = scoreOnePair(a, b, withLyrics, lyricsById, bpmTol);
    if (!pair) return;
    if (filters?.minHarmonicScore != null && pair.harmonic_score < filters.minHarmonicScore) {
      return;
    }
    if (filters?.minLyricScore != null && pair.lyric_score < filters.minLyricScore) {
      return;
    }
    if (filters?.requireBridge && !pair.bridge_phrases.trim()) return;
    out.push(pair);
  };

  if (directed) {
    for (const a of seedList) {
      for (const b of poolList) {
        if (out.length >= maxPairs) return sortPairs(out);
        push(a, b);
      }
    }
  } else {
    // Undirected within combined unique list of seeds (playlist-only)
    const songs = seedList;
    for (let i = 0; i < songs.length; i++) {
      for (let j = i + 1; j < songs.length; j++) {
        if (out.length >= maxPairs) return sortPairs(out);
        push(songs[i], songs[j]);
      }
    }
  }

  return sortPairs(out);
}

/** Back-compat helper for CLI: undirected pairs within one list */
export function generatePairsFromCatalog(opts: {
  songs: EnrichedSong[];
  lyricsDir?: string;
  withLyrics: boolean;
  filters?: PairFilters;
}): PairCandidate[] {
  const lyricsById = new Map<string, LyricBundle>();
  if (opts.withLyrics && opts.lyricsDir) {
    for (const s of opts.songs) {
      const textPath = path.join(opts.lyricsDir, `${s.spotify_id_resolved}.txt`);
      if (!fs.existsSync(textPath)) continue;
      const text = fs.readFileSync(textPath, "utf8");
      let timed: TimedLine[] = [];
      const timedPath = path.join(opts.lyricsDir, `${s.spotify_id_resolved}.timed.json`);
      if (fs.existsSync(timedPath)) {
        try {
          timed = JSON.parse(fs.readFileSync(timedPath, "utf8")) as TimedLine[];
        } catch {
          timed = [];
        }
      }
      lyricsById.set(s.spotify_id_resolved, { text, timed });
    }
  }
  return generatePairCandidates({
    seeds: opts.songs,
    pool: opts.songs,
    lyricsById,
    withLyrics: opts.withLyrics,
    directed: false,
    filters: opts.filters,
  });
}

function sortPairs(pairs: PairCandidate[]): PairCandidate[] {
  return [...pairs].sort((x, y) => {
    const cx =
      0.62 * x.harmonic_score +
      0.38 * x.lyric_score -
      (0.62 * y.harmonic_score + 0.38 * y.lyric_score);
    if (Math.abs(cx) > 1e-6) return cx < 0 ? 1 : -1;
    return x.bpm_delta - y.bpm_delta;
  });
}

export function writePairCsv(pairs: PairCandidate[], outPath: string): void {
  const cols = [
    "song_a_artist",
    "song_a_title",
    "song_a_spotify_id",
    "song_b_artist",
    "song_b_title",
    "song_b_spotify_id",
    "bpm_a",
    "bpm_b",
    "bpm_delta",
    "camelot_a",
    "camelot_b",
    "key_relationship",
    "harmonic_score",
    "lyric_score",
    "bridge_phrases",
    "notes",
  ] as const;
  const rows = pairs.map((p) => ({
    song_a_artist: p.song_a_artist,
    song_a_title: p.song_a_title,
    song_a_spotify_id: p.song_a_spotify_id,
    song_b_artist: p.song_b_artist,
    song_b_title: p.song_b_title,
    song_b_spotify_id: p.song_b_spotify_id,
    bpm_a: String(p.bpm_a),
    bpm_b: String(p.bpm_b),
    bpm_delta: String(p.bpm_delta.toFixed(3)),
    camelot_a: p.camelot_a,
    camelot_b: p.camelot_b,
    key_relationship: p.key_relationship,
    harmonic_score: p.harmonic_score.toFixed(4),
    lyric_score: p.lyric_score.toFixed(4),
    bridge_phrases: p.bridge_phrases,
    notes: p.notes,
  }));
  const csv = stringify(rows, { header: true, columns: [...cols] });
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, csv, "utf8");
}

// Re-export old name used by CLI
export { generatePairsFromCatalog as generatePairCandidatesLegacy };
