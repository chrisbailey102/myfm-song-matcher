/**
 * Lyric Board bridge generator (v1 — cheap / rule-based).
 * Future: optional LLM rerank of these validated contiguous chips only (no invented words).
 */
import crypto from "node:crypto";
import { isMikCompatible } from "./camelot.js";
import { listSongsForProject } from "./db/songs.js";
import { getLyricBoard } from "./db/lyricBoards.js";
import { listLyricsForSpotifyIds, parseTimedJson } from "./db/lyricsCache.js";
import type { TimedLine } from "./lrclib.js";

export type BridgeChip = {
  id: string;
  spotifyId: string;
  artist: string;
  title: string;
  text: string;
  startMs: number | null;
  sourceIndex: number;
  tempo: number | null;
  camelot: string;
};

export type LyricBridgeSuggestion = {
  hash: string;
  sentence: string;
  chips: BridgeChip[];
  score: number;
  keyBpmMatched: boolean;
};

export type GenerateLyricBoardOpts = {
  songsPerBridge: 2 | 3 | 4;
  batchSize: 10 | 20 | 50;
  direction?: string;
  matchKeyBpm?: boolean;
  cursor?: number;
};

type SongCtx = {
  spotifyId: string;
  artist: string;
  title: string;
  tempo: number;
  camelot: string;
  plain: string;
  timed: TimedLine[];
  suffixes: PhraseChip[];
  prefixes: PhraseChip[];
};

type PhraseChip = {
  text: string;
  startMs: number | null;
  sourceIndex: number;
  role: "suffix" | "prefix" | "line";
};

const OPEN_ENDINGS = new Set([
  "to", "the", "a", "an", "my", "your", "our", "their", "of", "and", "or", "but",
  "for", "with", "in", "on", "at", "into", "im", "i'm", "i", "you", "we", "she",
  "he", "they", "need", "want", "love", "like", "favourite", "favorite", "addicted",
  "can't", "cant", "cannot", "never", "always", "just", "so", "this", "that",
  "is", "was", "am", "are", "be", "been", "have", "got", "get", "make", "take",
  "give", "let", "from", "all", "no", "not",
]);

function normSpace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function words(s: string): string[] {
  return normSpace(s).split(" ").filter(Boolean);
}

function findSourceIndex(plain: string, phrase: string): number {
  const idx = plain.toLowerCase().indexOf(phrase.toLowerCase());
  return idx;
}

function sliceWords(line: string, from: number, to: number): string {
  const w = words(line);
  return w.slice(from, to).join(" ");
}

function chipsFromSong(
  plain: string,
  timed: TimedLine[],
): { suffixes: PhraseChip[]; prefixes: PhraseChip[] } {
  const suffixes: PhraseChip[] = [];
  const prefixes: PhraseChip[] = [];
  const seen = new Set<string>();

  const push = (list: PhraseChip[], text: string, startMs: number | null, role: PhraseChip["role"]) => {
    const t = normSpace(text);
    const wc = words(t).length;
    if (wc < 2 || wc > 8) return;
    if (t.length < 5) return;
    const key = `${role}:${t.toLowerCase()}`;
    if (seen.has(key)) return;
    const sourceIndex = findSourceIndex(plain, t);
    if (sourceIndex < 0) return;
    seen.add(key);
    list.push({ text: plain.slice(sourceIndex, sourceIndex + t.length), startMs, sourceIndex, role });
  };

  const lines =
    timed.length > 0
      ? timed.filter((l) => l.text.trim().length > 2)
      : plain
          .split(/\n+/)
          .map((text) => ({ text, startMs: -1 as number }))
          .filter((l) => l.text.trim().length > 2);

  for (const line of lines) {
    const ms = line.startMs >= 0 ? line.startMs : null;
    const w = words(line.text);
    if (w.length < 2) continue;
    push(suffixes, line.text, ms, "line");
    push(prefixes, line.text, ms, "line");
    for (let n = 2; n <= Math.min(5, w.length); n++) {
      push(suffixes, sliceWords(line.text, w.length - n, w.length), ms, "suffix");
      push(prefixes, sliceWords(line.text, 0, n), ms, "prefix");
    }
  }

  return { suffixes, prefixes };
}

function joinScore(a: PhraseChip, b: PhraseChip, directionTerms: string[]): number {
  const wa = words(a.text);
  const wb = words(b.text);
  if (!wa.length || !wb.length) return -1;
  let score = 0;
  const last = wa[wa.length - 1].toLowerCase().replace(/[^a-z']/g, "");
  const first = wb[0].toLowerCase().replace(/[^a-z']/g, "");
  if (OPEN_ENDINGS.has(last)) score += 3;
  if (last === first) score -= 4; // "the the"
  if (/[.!?]$/.test(a.text.trim())) score -= 2;
  const totalWords = wa.length + wb.length;
  if (totalWords >= 4 && totalWords <= 14) score += 2;
  else if (totalWords > 16) score -= 1;
  if (a.role === "suffix" || a.role === "line") score += 0.5;
  if (b.role === "prefix" || b.role === "line") score += 0.5;
  if (a.startMs != null && b.startMs != null) score += 0.5;
  const blob = `${a.text} ${b.text}`.toLowerCase();
  for (const term of directionTerms) {
    if (term && blob.includes(term)) score += 1.5;
  }
  return score;
}

function harmonicOk(
  a: SongCtx,
  b: SongCtx,
  matchKeyBpm: boolean,
  bpmTol: number,
): boolean {
  if (!matchKeyBpm) return true;
  if (!a.tempo || !b.tempo || !a.camelot || !b.camelot) return false;
  if (Math.abs(a.tempo - b.tempo) > bpmTol) return false;
  return isMikCompatible(a.camelot, b.camelot);
}

function toBridgeChip(song: SongCtx, phrase: PhraseChip): BridgeChip {
  return {
    id: crypto.randomUUID(),
    spotifyId: song.spotifyId,
    artist: song.artist,
    title: song.title,
    text: phrase.text,
    startMs: phrase.startMs,
    sourceIndex: phrase.sourceIndex,
    tempo: song.tempo || null,
    camelot: song.camelot,
  };
}

function bridgeHash(chips: BridgeChip[]): string {
  const key = chips.map((c) => `${c.spotifyId}:${c.text.toLowerCase()}`).join("|");
  return crypto.createHash("sha1").update(key).digest("hex").slice(0, 16);
}

export async function generateLyricBoardBridges(
  projectId: string,
  opts: GenerateLyricBoardOpts,
): Promise<{ suggestions: LyricBridgeSuggestion[]; nextCursor: number | null; total: number }> {
  const songsPerBridge = opts.songsPerBridge;
  const batchSize = opts.batchSize;
  const matchKeyBpm = opts.matchKeyBpm !== false;
  const cursor = Math.max(0, Math.floor(opts.cursor || 0));
  const bpmTol = 12;
  const directionTerms = String(opts.direction || "")
    .toLowerCase()
    .split(/[^a-z0-9']+/)
    .filter((t) => t.length > 2);

  const songs = await listSongsForProject(projectId);
  const ids = songs.map((s) => s.spotify_id_resolved).filter(Boolean);
  const lyricsMap = await listLyricsForSpotifyIds(ids);
  const { dismissed } = await getLyricBoard(projectId);
  const dismissedSet = new Set(dismissed);

  const contexts: SongCtx[] = [];
  for (const s of songs) {
    const id = s.spotify_id_resolved;
    const lyric = lyricsMap.get(id);
    if (!lyric?.plain_text || lyric.plain_text.length < 20) continue;
    const tempo =
      s.tempo_override != null && Number(s.tempo_override) > 0
        ? Number(s.tempo_override)
        : Number(s.tempo) || 0;
    const camelot = String(s.camelot_override || s.camelot || "")
      .trim()
      .toUpperCase();
    const timed = parseTimedJson(lyric.timed_json);
    const { suffixes, prefixes } = chipsFromSong(lyric.plain_text, timed);
    if (!suffixes.length || !prefixes.length) continue;
    contexts.push({
      spotifyId: id,
      artist: s.artist,
      title: s.title,
      tempo,
      camelot,
      plain: lyric.plain_text,
      timed,
      suffixes,
      prefixes,
    });
  }

  if (contexts.length < songsPerBridge) {
    return { suggestions: [], nextCursor: null, total: 0 };
  }

  type Cand = { chips: BridgeChip[]; score: number; keyBpmMatched: boolean };
  const candidates: Cand[] = [];
  const seen = new Set<string>();

  const pushCand = (parts: Array<{ song: SongCtx; phrase: PhraseChip }>, score: number, keyOk: boolean) => {
    if (parts.length !== songsPerBridge) return;
    const idsUsed = new Set(parts.map((p) => p.song.spotifyId));
    if (idsUsed.size !== songsPerBridge) return;
    const chips = parts.map((p) => toBridgeChip(p.song, p.phrase));
    const hash = bridgeHash(chips);
    if (seen.has(hash) || dismissedSet.has(hash)) return;
    seen.add(hash);
    candidates.push({ chips, score, keyBpmMatched: keyOk });
  };

  // 2-song bridges
  if (songsPerBridge === 2) {
    for (let i = 0; i < contexts.length; i++) {
      for (let j = 0; j < contexts.length; j++) {
        if (i === j) continue;
        const A = contexts[i];
        const B = contexts[j];
        const keyOk = harmonicOk(A, B, matchKeyBpm, bpmTol);
        if (matchKeyBpm && !keyOk) continue;
        const suf = A.suffixes.slice(0, 24);
        const pre = B.prefixes.slice(0, 24);
        for (const a of suf) {
          for (const b of pre) {
            const sc = joinScore(a, b, directionTerms);
            if (sc < 2.5) continue;
            pushCand(
              [
                { song: A, phrase: a },
                { song: B, phrase: b },
              ],
              sc + (keyOk ? 0.5 : 0),
              keyOk,
            );
          }
        }
      }
    }
  } else {
    // 3–4: build from strong 2-joins then extend
    type Edge = { a: number; b: number; ap: PhraseChip; bp: PhraseChip; score: number; keyOk: boolean };
    const edges: Edge[] = [];
    for (let i = 0; i < contexts.length; i++) {
      for (let j = 0; j < contexts.length; j++) {
        if (i === j) continue;
        const keyOk = harmonicOk(contexts[i], contexts[j], matchKeyBpm, bpmTol);
        if (matchKeyBpm && !keyOk) continue;
        for (const a of contexts[i].suffixes.slice(0, 16)) {
          for (const b of contexts[j].prefixes.slice(0, 16)) {
            const sc = joinScore(a, b, directionTerms);
            if (sc < 2.8) continue;
            edges.push({ a: i, b: j, ap: a, bp: b, score: sc, keyOk });
          }
        }
      }
    }
    edges.sort((x, y) => y.score - x.score);
    const topEdges = edges.slice(0, 800);

    for (const e1 of topEdges) {
      if (songsPerBridge === 3) {
        for (const e2 of topEdges) {
          if (e2.a !== e1.b) continue;
          if (e2.b === e1.a || e2.b === e1.b) continue;
          // middle song must use compatible chip text — use e1.bp as the middle chip
          const mid = e1.bp;
          const sc = e1.score + e2.score;
          pushCand(
            [
              { song: contexts[e1.a], phrase: e1.ap },
              { song: contexts[e1.b], phrase: mid },
              { song: contexts[e2.b], phrase: e2.bp },
            ],
            sc / 2,
            e1.keyOk && e2.keyOk,
          );
        }
      } else {
        // 4 songs
        for (const e2 of topEdges) {
          if (e2.a !== e1.b) continue;
          if (new Set([e1.a, e1.b, e2.b]).size < 3) continue;
          for (const e3 of topEdges) {
            if (e3.a !== e2.b) continue;
            const used = new Set([e1.a, e1.b, e2.b, e3.b]);
            if (used.size < 4) continue;
            const sc = e1.score + e2.score + e3.score;
            pushCand(
              [
                { song: contexts[e1.a], phrase: e1.ap },
                { song: contexts[e1.b], phrase: e1.bp },
                { song: contexts[e2.b], phrase: e2.bp },
                { song: contexts[e3.b], phrase: e3.bp },
              ],
              sc / 3,
              e1.keyOk && e2.keyOk && e3.keyOk,
            );
          }
        }
      }
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  // Cap pool so we don't explode memory; Generate more walks this list
  const pool = candidates.slice(0, 400);
  const slice = pool.slice(cursor, cursor + batchSize);
  const suggestions: LyricBridgeSuggestion[] = slice.map((c) => ({
    hash: bridgeHash(c.chips),
    sentence: c.chips.map((x) => x.text).join(" "),
    chips: c.chips,
    score: c.score,
    keyBpmMatched: c.keyBpmMatched,
  }));
  const next = cursor + batchSize;
  return {
    suggestions,
    nextCursor: next < pool.length ? next : null,
    total: pool.length,
  };
}

/** Ensure every chip text is still a contiguous substring of that song's lyrics. */
export function validateBoardChips(
  chips: BridgeChip[],
  plainById: Map<string, string>,
): { ok: true } | { ok: false; error: string } {
  for (const chip of chips) {
    const plain = plainById.get(chip.spotifyId);
    if (!plain) return { ok: false, error: `Missing lyrics for ${chip.title}` };
    const text = normSpace(chip.text);
    if (words(text).length < 1) return { ok: false, error: "Empty chip" };
    const idx =
      chip.sourceIndex >= 0 &&
      plain.slice(chip.sourceIndex, chip.sourceIndex + text.length).toLowerCase() ===
        text.toLowerCase()
        ? chip.sourceIndex
        : findSourceIndex(plain, text);
    if (idx < 0) {
      return {
        ok: false,
        error: `Chip is not a true lyric substring: “${text}” (${chip.artist})`,
      };
    }
  }
  return { ok: true };
}
