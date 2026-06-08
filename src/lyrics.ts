import fs from "node:fs";
import path from "node:path";
import type { EnrichedSong } from "./types.js";
import { optionalEnv } from "./config.js";
import { Client } from "genius-lyrics";

let client: Client | null = null;

function getClient(): Client | null {
  const token = optionalEnv("GENIUS_ACCESS_TOKEN");
  if (!token) return null;
  if (!client) client = new Client(token);
  return client;
}

export async function fetchLyricsForSong(
  artist: string,
  title: string,
): Promise<{ text: string; source: string } | null> {
  const c = getClient();
  if (!c) return null;
  const q = `${artist} ${title}`;
  const hits = await c.songs.search(q);
  if (!hits.length) return null;
  const text = await hits[0].lyrics();
  return { text, source: "genius" };
}

export function lyricsPathForId(lyricsDir: string, spotifyId: string): string {
  return path.join(lyricsDir, `${spotifyId}.txt`);
}

export async function ensureLyricsOnDisk(
  song: EnrichedSong,
  lyricsDir: string,
  force: boolean,
): Promise<{ ok: boolean; source: string; reason?: string }> {
  const outFile = lyricsPathForId(lyricsDir, song.spotify_id_resolved);
  if (!force && fs.existsSync(outFile)) {
    return { ok: true, source: "cache" };
  }
  const got = await fetchLyricsForSong(song.artist, song.title);
  if (!got) {
    return { ok: false, source: "", reason: "no_genius_token_or_no_match" };
  }
  fs.mkdirSync(lyricsDir, { recursive: true });
  fs.writeFileSync(outFile, got.text, "utf8");
  return { ok: true, source: got.source };
}

export function readLyricsFile(lyricsDir: string, spotifyId: string): string | null {
  const p = lyricsPathForId(lyricsDir, spotifyId);
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p, "utf8");
}

const STOP = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "but",
  "in",
  "on",
  "at",
  "to",
  "for",
  "of",
  "as",
  "is",
  "it",
  "i",
  "you",
  "we",
  "they",
  "me",
  "my",
  "your",
  "ya",
  "uh",
  "oh",
  "yeah",
  "na",
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

export function scoreLyricPair(textA: string, textB: string): {
  score: number;
  bridges: string[];
} {
  const ta = tokenize(textA);
  const tb = tokenize(textB);
  if (ta.length < 4 || tb.length < 4) return { score: 0, bridges: [] };

  const setB = new Set(tb);
  let overlap = 0;
  for (const w of ta) if (setB.has(w)) overlap++;
  const jaccardWords = overlap / new Set([...ta, ...tb]).size;

  const biA = new Set(ngrams(ta, 2));
  const biB = ngrams(tb, 2);
  const sharedBi = biB.filter((x) => biA.has(x));

  const linesA = textA.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  const linesB = textB.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  const tail = linesA.slice(-4).join(" ");
  const head = linesB.slice(0, 4).join(" ");
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

  const score = Math.min(
    1,
    0.35 * jaccardWords * 5 +
      0.25 * Math.min(1, sharedBi.length / 8) +
      0.25 * bridgeTailHead * 3 +
      0.15 * Math.min(1, triShared.length / 4),
  );

  const bridges: string[] = [];
  for (const x of sharedBi.slice(0, 5)) bridges.push(x);
  for (const x of triShared.slice(0, 3)) bridges.push(x);

  return { score, bridges: [...new Set(bridges)] };
}
