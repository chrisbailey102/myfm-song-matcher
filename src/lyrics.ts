import fs from "node:fs";
import path from "node:path";
import type { EnrichedSong } from "./types.js";
import { optionalEnv } from "./config.js";
import { Client } from "genius-lyrics";
import { extractHookFocusedLyrics, formatMs, stripGeniusNoise } from "./lyricClean.js";
import {
  fetchLrcLib,
  plainTextFromLrcLib,
  timedLinesFromLrcLib,
  type TimedLine,
} from "./lrclib.js";

let client: Client | null = null;

function getClient(): Client | null {
  const token = optionalEnv("GENIUS_ACCESS_TOKEN");
  if (!token) return null;
  if (!client) client = new Client(token);
  return client;
}

export async function fetchGeniusLyrics(
  artist: string,
  title: string,
): Promise<{ text: string; source: string } | null> {
  const c = getClient();
  if (!c) return null;
  const hits = await c.songs.search(`${artist} ${title}`);
  if (!hits.length) return null;
  const text = await hits[0].lyrics();
  return { text: extractHookFocusedLyrics(text), source: "genius" };
}

/** Prefer LRCLIB (timed + clean), fall back to Genius. */
export async function fetchBestLyrics(
  artist: string,
  title: string,
  durationMs?: number,
): Promise<{
  text: string;
  source: "lrclib" | "genius";
  timedLines: TimedLine[];
} | null> {
  const durationSec = durationMs && durationMs > 0 ? durationMs / 1000 : undefined;
  try {
    const lrc = await fetchLrcLib(artist, title, durationSec);
    if (lrc && !lrc.instrumental) {
      const text = plainTextFromLrcLib(lrc);
      if (text.length > 20) {
        return {
          text,
          source: "lrclib",
          timedLines: timedLinesFromLrcLib(lrc),
        };
      }
    }
  } catch {
    // fall through to Genius
  }

  const g = await fetchGeniusLyrics(artist, title);
  if (!g) return null;
  return { text: g.text, source: "genius", timedLines: [] };
}

export function lyricsPathForId(lyricsDir: string, spotifyId: string): string {
  return path.join(lyricsDir, `${spotifyId}.txt`);
}

export function timedPathForId(lyricsDir: string, spotifyId: string): string {
  return path.join(lyricsDir, `${spotifyId}.timed.json`);
}

export async function ensureLyricsOnDisk(
  song: EnrichedSong,
  lyricsDir: string,
  force: boolean,
): Promise<{ ok: boolean; source: string; reason?: string }> {
  const outFile = lyricsPathForId(lyricsDir, song.spotify_id_resolved);
  const timedFile = timedPathForId(lyricsDir, song.spotify_id_resolved);
  if (!force && fs.existsSync(outFile)) {
    return { ok: true, source: "cache" };
  }
  const got = await fetchBestLyrics(song.artist, song.title, song.duration_ms);
  if (!got) {
    return { ok: false, source: "", reason: "no_lyrics_found" };
  }
  fs.mkdirSync(lyricsDir, { recursive: true });
  fs.writeFileSync(outFile, got.text, "utf8");
  if (got.timedLines.length) {
    fs.writeFileSync(timedFile, JSON.stringify(got.timedLines), "utf8");
  }
  return { ok: true, source: got.source };
}

export function readLyricsFile(lyricsDir: string, spotifyId: string): string | null {
  const p = lyricsPathForId(lyricsDir, spotifyId);
  if (!fs.existsSync(p)) return null;
  return stripGeniusNoise(fs.readFileSync(p, "utf8"));
}

export function readTimedLines(
  lyricsDir: string,
  spotifyId: string,
): TimedLine[] {
  const p = timedPathForId(lyricsDir, spotifyId);
  if (!fs.existsSync(p)) return [];
  try {
    return JSON.parse(fs.readFileSync(p, "utf8")) as TimedLine[];
  } catch {
    return [];
  }
}

const STOP = new Set([
  "the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for", "of",
  "as", "is", "it", "i", "you", "we", "they", "me", "my", "your", "ya", "uh",
  "oh", "yeah", "na", "ooh", "ah", "la", "da", "ba", "dee", "do", "dont",
  "don't", "im", "i'm", "its", "it's", "that", "this", "with", "from", "was",
  "were", "are", "be", "been", "have", "has", "had", "not", "no", "so", "if",
  "when", "what", "who", "how", "all", "just", "like", "can", "will", "get",
  "got", "more", "read", // filter Genius "read more" residue
]);

export function normalizeLyricText(s: string): string {
  return s
    .toLowerCase()
    .replace(/\[[^\]]+\]/g, " ")
    .replace(/[^a-z0-9\s']/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function tokenize(s: string): string[] {
  return normalizeLyricText(s)
    .split(" ")
    .filter((w) => w.length > 1 && !STOP.has(w));
}

export function ngrams(tokens: string[], n: number): string[] {
  const out: string[] = [];
  for (let i = 0; i + n <= tokens.length; i++) {
    out.push(tokens.slice(i, i + n).join(" "));
  }
  return out;
}

function lineTokens(line: string): string[] {
  return tokenize(line);
}

/** Find best timed line handoffs: end of A → start of B (or any strong line overlap). */
export function findTimedBridges(
  linesA: TimedLine[],
  linesB: TimedLine[],
): Array<{ phrase: string; aMs: number; bMs: number }> {
  const bridges: Array<{ phrase: string; aMs: number; bMs: number; score: number }> = [];
  const usableA = linesA.filter((l) => l.text.trim().length > 2);
  const usableB = linesB.filter((l) => l.text.trim().length > 2);
  if (!usableA.length || !usableB.length) return [];

  for (const a of usableA) {
    const ta = lineTokens(a.text);
    if (ta.length < 2) continue;
    const setA = new Set(ta);
    for (const b of usableB) {
      const tb = lineTokens(b.text);
      if (tb.length < 2) continue;
      let shared = 0;
      for (const w of tb) if (setA.has(w)) shared++;
      const biA = new Set(ngrams(ta, 2));
      const sharedBi = ngrams(tb, 2).filter((x) => biA.has(x));
      const score = sharedBi.length * 2 + shared / Math.max(ta.length, tb.length);
      if (sharedBi.length >= 1 || shared >= 3) {
        bridges.push({
          phrase: sharedBi[0] || [...setA].filter((w) => tb.includes(w)).slice(0, 3).join(" "),
          aMs: a.startMs,
          bMs: b.startMs,
          score,
        });
      }
    }
  }
  bridges.sort((x, y) => y.score - x.score);
  const seen = new Set<string>();
  const out: Array<{ phrase: string; aMs: number; bMs: number }> = [];
  for (const b of bridges) {
    if (!b.phrase || seen.has(b.phrase)) continue;
    seen.add(b.phrase);
    out.push({ phrase: b.phrase, aMs: b.aMs, bMs: b.bMs });
    if (out.length >= 5) break;
  }
  return out;
}

export function scoreLyricPair(
  textA: string,
  textB: string,
  timedA: TimedLine[] = [],
  timedB: TimedLine[] = [],
): {
  score: number;
  bridges: string[];
} {
  const cleanA = extractHookFocusedLyrics(textA);
  const cleanB = extractHookFocusedLyrics(textB);
  const ta = tokenize(cleanA);
  const tb = tokenize(cleanB);
  if (ta.length < 4 || tb.length < 4) return { score: 0, bridges: [] };

  const setB = new Set(tb);
  let overlap = 0;
  for (const w of ta) if (setB.has(w)) overlap++;
  const jaccardWords = overlap / new Set([...ta, ...tb]).size;

  const biA = new Set(ngrams(ta, 2));
  const biB = ngrams(tb, 2);
  const sharedBi = biB.filter((x) => biA.has(x));
  // Drop ultra-generic bigrams
  const sharedBiFiltered = sharedBi.filter(
    (x) => !["read more", "you know", "oh oh", "na na"].includes(x),
  );

  const linesA = cleanA.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  const linesB = cleanB.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  const tail = linesA.slice(-6).join(" ");
  const head = linesB.slice(0, 6).join(" ");
  const tailTok = tokenize(tail);
  const headTok = tokenize(head);
  const headSet = new Set(headTok);
  let bridgeWords = 0;
  for (const w of tailTok) if (headSet.has(w)) bridgeWords++;
  const bridgeTailHead =
    tailTok.length && headTok.length
      ? bridgeWords / Math.sqrt(tailTok.length * headTok.length)
      : 0;

  const triA = new Set(ngrams(ta, 3));
  const triShared = ngrams(tb, 3).filter((x) => triA.has(x));

  let score = Math.min(
    1,
    0.25 * Math.min(1, jaccardWords * 4) +
      0.3 * Math.min(1, sharedBiFiltered.length / 6) +
      0.3 * Math.min(1, bridgeTailHead * 2.5) +
      0.15 * Math.min(1, triShared.length / 3),
  );

  const bridges: string[] = [];
  for (const x of sharedBiFiltered.slice(0, 5)) bridges.push(x);
  for (const x of triShared.slice(0, 3)) bridges.push(x);

  const timed = findTimedBridges(timedA, timedB);
  if (timed.length) {
    score = Math.min(1, score + 0.15);
    for (const t of timed.slice(0, 3)) {
      const label =
        t.aMs >= 0 && t.bMs >= 0
          ? `${t.phrase} (A@${formatMs(t.aMs)}→B@${formatMs(t.bMs)})`
          : t.phrase;
      bridges.push(label);
    }
  }

  return { score, bridges: [...new Set(bridges)].slice(0, 8) };
}
