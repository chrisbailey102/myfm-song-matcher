import fs from "node:fs";
import path from "node:path";
import { stringify } from "csv-stringify/sync";
import type { EnrichedSong, PairCandidate } from "./types.js";
import {
  harmonicComponent,
  isMikCompatible,
  keyRelationship,
  bpmClosenessScore,
} from "./camelot.js";
import { getBpmTolerance, getMaxPairs } from "./config.js";
import { readLyricsFile, scoreLyricPair } from "./lyrics.js";

export type PairGenOptions = {
  songs: EnrichedSong[];
  lyricsDir?: string;
  /** If false, skip lyric IO and set lyric_score 0 */
  withLyrics: boolean;
};

export function generatePairCandidates(opts: PairGenOptions): PairCandidate[] {
  const { songs, lyricsDir, withLyrics } = opts;
  const maxPairs = getMaxPairs();
  const bpmTol = getBpmTolerance();
  const out: PairCandidate[] = [];
  const n = songs.length;

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (out.length >= maxPairs) return sortPairs(out);
      const a = songs[i];
      const b = songs[j];
      if (!a.camelot || !b.camelot) continue;
      if (!a.tempo || !b.tempo) continue;
      const bpmDelta = Math.abs(a.tempo - b.tempo);
      if (bpmDelta > bpmTol) continue;
      if (!isMikCompatible(a.camelot, b.camelot)) continue;

      let lyricScore = 0;
      let bridges = "";
      let notes = "";
      if (withLyrics && lyricsDir) {
        const la = readLyricsFile(lyricsDir, a.spotify_id_resolved);
        const lb = readLyricsFile(lyricsDir, b.spotify_id_resolved);
        if (la && lb) {
          const s = scoreLyricPair(la, lb);
          lyricScore = s.score;
          bridges = s.bridges.join(" | ");
        } else {
          notes = "missing_lyrics_for_one_or_both";
        }
      }

      const harmonic = harmonicComponent(a.camelot, b.camelot, a.tempo, b.tempo);
      const combined = 0.62 * harmonic + 0.38 * lyricScore;

      out.push({
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
      });
    }
  }
  return sortPairs(out);
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
