/**
 * Lyric Board bridge generator (v1 — cheap / rule-based).
 * Future: optional LLM rerank of these validated contiguous chips only (no invented words).
 *
 * Quality rules (strict):
 * - Continuations must read as a closed clause (verb + enough words, not dangling).
 * - Nested variants of the same join collapse to the fullest good sentence.
 * - Batches diversify opening chips so one lyric doesn’t dominate.
 */
import crypto from "node:crypto";
import { isMikCompatible } from "./camelot.js";
import { listLibraryTracks } from "./db/library.js";
import { getLyricBoard, libraryBoardScope } from "./db/lyricBoards.js";
import { listLyricsForSpotifyIds, parseTimedJson } from "./db/lyricsCache.js";
import { listSongsForProject } from "./db/songs.js";
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
  /** True when every enabled constraint passed (legacy + UI). */
  keyBpmMatched: boolean;
  keyMatched: boolean;
  bpmMatched: boolean;
  filters: { key: boolean; bpm: boolean };
};

export type GenerateLyricBoardOpts = {
  songsPerBridge: 2 | 3 | 4;
  batchSize: 10 | 20 | 50;
  direction?: string;
  /** Prefer Camelot-compatible keys (default true). */
  matchKey?: boolean;
  /** Prefer close tempos (default true). */
  matchBpm?: boolean;
  /** @deprecated Use matchKey / matchBpm. If set and new flags omitted, applies to both. */
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

/** Words that leave a phrase hanging — fine for chip A, bad for a final chip. */
const OPEN_ENDINGS = new Set([
  "to", "the", "a", "an", "my", "your", "our", "their", "of", "and", "or", "but",
  "for", "with", "in", "on", "at", "into", "im", "i'm", "i", "you", "we", "she",
  "he", "they", "need", "want", "love", "like", "favourite", "favorite", "addicted",
  "can't", "cant", "cannot", "never", "always", "just", "so", "this", "that",
  "is", "was", "am", "are", "be", "been", "have", "has", "had", "got", "get", "gets",
  "make", "take", "give", "let", "from", "all", "no", "not", "as", "if", "when",
  "while", "because", "cause", "'cause", "than", "then", "by", "up", "down", "out",
  "off", "over", "under", "about", "through", "after", "before", "between",
]);

/** Lone verbs / progressives that usually mean the lyric was cut short. */
const DANGLING_TAILS = new Set([
  "come", "comes", "came", "go", "goes", "going", "gone",
  "try", "trying", "sing", "singing", "look", "looking", "feel", "feeling",
  "wait", "waiting", "run", "running", "walk", "walking", "dance", "dancing",
  "fall", "falling", "call", "calling", "keep", "keeping", "hold", "holding",
  "turn", "turning", "leave", "leaving", "wanna", "gonna", "gotta", "gimme",
  "know", "knowing", "see", "seeing", "hear", "hearing", "think", "thinking",
  "find", "finding", "make", "making", "take", "taking", "give", "giving",
  "do", "doing", "did", "say", "saying", "said", "put", "putting",
]);

/**
 * Endings that invite a continuation (articles/prepositions + complement verbs
 * like “I've realized …” / “I know …”).
 */
const OPENING_TAILS = new Set([
  ...OPEN_ENDINGS,
  "realized", "realised", "know", "knew", "feel", "felt", "say", "said",
  "believe", "think", "thought", "wonder", "hope", "wish", "remember",
  "hear", "heard", "see", "saw", "swear", "promise", "dream", "dreamed", "dreamt",
  "tell", "told", "ask", "asked", "show", "miss", "hate", "found",
  "decided", "noticed", "learned", "learnt", "understood", "guess", "guessed",
  "forget", "forgot", "need", "needed", "want", "wanted", "love", "loved",
]);

const LYRIC_VERB_RE =
  /\b(is|are|was|were|am|be|been|being|have|has|had|got|get|gets|getting|come|comes|came|coming|go|goes|going|gone|need|needs|needed|want|wants|wanted|love|loves|loved|know|knows|knew|feel|feels|felt|make|makes|made|take|takes|took|give|gives|gave|let|lets|say|says|said|do|does|did|can|can't|cannot|will|won't|would|could|should|sing|sings|sang|singing|dance|dances|dancing|run|runs|ran|running|walk|walks|walked|walking|try|tries|tried|trying|look|looks|looked|looking|see|sees|saw|seeing|hear|hears|heard|think|thinks|thought|find|finds|found|keep|keeps|kept|hold|holds|held|turn|turns|turned|fall|falls|fell|falling|rise|rises|rose|put|puts|leave|leaves|left|call|calls|called|calling|bring|brings|brought|watch|watches|watched|dream|dreams|dreamed|dreamt|cry|cries|cried|laugh|laughs|laughed|play|plays|played|playing|move|moves|moved|moving|break|breaks|broke|broken|stay|stays|stayed|start|starts|started|stop|stops|stopped|lose|loses|lost|win|wins|won|live|lives|lived|die|dies|died|remember|remembers|forgot|forget|believe|believes|happen|happens|happened)\b/i;

/** Cap library scans so generate stays responsive on huge catalogs. */
const MAX_SONG_CONTEXTS = 120;
/** Max suggestions that share the same opening chip text in the ranked pool. */
const MAX_PER_OPENING = 1;
/** Max suggestions that share the same song-A → song-B pairing in the pool. */
const MAX_PER_SONG_PAIR = 2;

function normSpace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function words(s: string): string[] {
  return normSpace(s).split(" ").filter(Boolean);
}

function lastWord(s: string): string {
  const w = words(s);
  return (w[w.length - 1] || "").toLowerCase().replace(/[^a-z']/g, "");
}

function findSourceIndex(plain: string, phrase: string): number {
  return plain.toLowerCase().indexOf(phrase.toLowerCase());
}

function sliceWords(line: string, from: number, to: number): string {
  const w = words(line);
  return w.slice(from, to).join(" ");
}

function endsConnective(text: string): boolean {
  return OPENING_TAILS.has(lastWord(text)) || /,$/.test(normSpace(text));
}

function endsDangling(text: string): boolean {
  const tail = lastWord(text);
  if (OPEN_ENDINGS.has(tail) || DANGLING_TAILS.has(tail)) return true;
  // Progressive as final word is usually cut off (“…trying”, “…singing”)
  if (
    /ing$/.test(tail) &&
    !/^(morning|evening|darling|something|anything|everything|nothing|feeling)$/.test(tail)
  ) {
    return true;
  }
  return false;
}

/** Continuation chip B/C/… must stand as a closed clause fragment. */
function isClosedContinuation(text: string): boolean {
  const t = normSpace(text).replace(/[,;:]+$/, "");
  const w = words(t);
  if (w.length < 4) return false;
  if (endsDangling(t)) return false;
  if (!LYRIC_VERB_RE.test(t)) return false;
  // Pure “Down in the tunnels” style PPs with no verb already fail verb check;
  // also reject tiny NP-only leftovers that somehow matched a weak verb token.
  if (w.length < 5 && /^(down|up|in|on|at|from|to|with|through|over|under|into|out)\b/i.test(t)) {
    return false;
  }
  return true;
}

/** Opening chip: long enough and invites a continuation. */
function isGoodOpening(text: string): boolean {
  const w = words(text);
  if (w.length < 3 || w.length > 10) return false;
  return endsConnective(text);
}

function hasLyricVerb(text: string): boolean {
  return LYRIC_VERB_RE.test(text);
}

function chipsFromSong(
  plain: string,
  timed: TimedLine[],
): { suffixes: PhraseChip[]; prefixes: PhraseChip[] } {
  const suffixes: PhraseChip[] = [];
  const prefixes: PhraseChip[] = [];
  const seen = new Set<string>();

  const push = (
    list: PhraseChip[],
    text: string,
    startMs: number | null,
    role: PhraseChip["role"],
    kind: "open" | "closed",
  ) => {
    const t = normSpace(text).replace(/[,;:]+$/, "");
    const wc = words(t).length;
    if (kind === "open") {
      if (wc < 3 || wc > 9) return;
      if (!endsConnective(t)) return;
    } else {
      if (wc < 4 || wc > 9) return;
      if (!isClosedContinuation(t)) return;
    }
    if (t.length < 8) return;
    const key = `${kind}:${t.toLowerCase()}`;
    if (seen.has(key)) return;
    const sourceIndex = findSourceIndex(plain, t);
    if (sourceIndex < 0) return;
    // Recover original casing / trailing comma from source when present
    let recovered = plain.slice(sourceIndex, sourceIndex + t.length);
    const after = plain.slice(sourceIndex + t.length, sourceIndex + t.length + 1);
    if (after === ",") recovered += ",";
    seen.add(key);
    list.push({ text: recovered, startMs, sourceIndex, role });
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
    if (w.length < 3) continue;

    // Full line as opening if connective; as continuation if closed clause
    if (isGoodOpening(line.text)) {
      push(suffixes, line.text, ms, "line", "open");
    }
    if (isClosedContinuation(line.text)) {
      push(prefixes, line.text, ms, "line", "closed");
    }

    // Word-window chips: openings = line tails; continuations = line heads
    for (let n = 3; n <= Math.min(8, w.length); n++) {
      push(suffixes, sliceWords(line.text, w.length - n, w.length), ms, "suffix", "open");
      push(prefixes, sliceWords(line.text, 0, n), ms, "prefix", "closed");
    }
  }

  // Prefer longer, more informative chips first
  const byLen = (a: PhraseChip, b: PhraseChip) => words(b.text).length - words(a.text).length;
  suffixes.sort(byLen);
  prefixes.sort(byLen);
  return { suffixes, prefixes };
}

function joinScore(a: PhraseChip, b: PhraseChip, directionTerms: string[]): number {
  if (!isGoodOpening(a.text) || !isClosedContinuation(b.text)) return -1;
  const wa = words(a.text);
  const wb = words(b.text);
  let score = 0;
  const last = lastWord(a.text);
  const first = wb[0].toLowerCase().replace(/[^a-z']/g, "");
  if (endsConnective(a.text)) score += 4;
  else score -= 1;
  if (last === first) return -1;
  if (/[.!?]$/.test(a.text.trim())) return -1;

  const totalWords = wa.length + wb.length;
  if (totalWords < 8) return -1;
  if (totalWords >= 9 && totalWords <= 16) score += 3;
  else if (totalWords <= 20) score += 1;
  else score -= 2;

  // Prefer fuller continuations (user: keep “Here come Johnny singing oldies” over stubs)
  score += Math.min(4, wb.length - 3) * 0.6;
  if (hasLyricVerb(b.text)) score += 2;
  if (a.startMs != null && b.startMs != null) score += 0.5;

  const blob = `${a.text} ${b.text}`.toLowerCase();
  for (const term of directionTerms) {
    if (term && blob.includes(term)) score += 1.5;
  }
  return score;
}

function sentenceQuality(chips: BridgeChip[]): number {
  if (chips.length < 2) return -100;
  const texts = chips.map((c) => c.text);
  if (!isGoodOpening(texts[0])) return -100;
  for (let i = 1; i < texts.length; i++) {
    if (!isClosedContinuation(texts[i])) return -100;
  }
  const joined = texts.join(" ");
  const total = words(joined).length;
  let q = 0;
  if (endsConnective(texts[0])) q += 3;
  if (total >= 9 && total <= 16) q += 4;
  else if (total >= 8 && total <= 20) q += 2;
  else q -= 2;
  // Longer final chip wins among near-duplicates
  q += Math.min(5, words(texts[texts.length - 1]).length) * 0.4;
  return q;
}

function resolveMatchFlags(opts: GenerateLyricBoardOpts): {
  matchKey: boolean;
  matchBpm: boolean;
} {
  const legacy = opts.matchKeyBpm;
  return {
    matchKey:
      opts.matchKey !== undefined ? opts.matchKey !== false : legacy !== false,
    matchBpm:
      opts.matchBpm !== undefined ? opts.matchBpm !== false : legacy !== false,
  };
}

function pairMatch(
  a: SongCtx,
  b: SongCtx,
  matchKey: boolean,
  matchBpm: boolean,
  bpmTol: number,
): { ok: boolean; keyMatched: boolean; bpmMatched: boolean } {
  let keyMatched = true;
  let bpmMatched = true;
  if (matchKey) {
    keyMatched = Boolean(a.camelot && b.camelot && isMikCompatible(a.camelot, b.camelot));
  }
  if (matchBpm) {
    bpmMatched = Boolean(
      a.tempo &&
        b.tempo &&
        Math.abs(a.tempo - b.tempo) <= bpmTol,
    );
  }
  return { ok: keyMatched && bpmMatched, keyMatched, bpmMatched };
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

function openingKey(chips: BridgeChip[]): string {
  return `${chips[0].spotifyId}:${chips[0].text.toLowerCase()}`;
}

function pairKey(chips: BridgeChip[]): string {
  return chips.map((c) => c.spotifyId).join(">");
}

type Cand = {
  chips: BridgeChip[];
  score: number;
  keyBpmMatched: boolean;
  keyMatched: boolean;
  bpmMatched: boolean;
  filters: { key: boolean; bpm: boolean };
  quality: number;
};

/** Keep the fullest good sentence when B is a prefix of a longer sibling join. */
function collapseNestedDuplicates(candidates: Cand[]): Cand[] {
  const byJoin = new Map<string, Cand[]>();
  for (const c of candidates) {
    if (c.quality < 0) continue;
    const a = c.chips[0];
    const restSongs = c.chips.slice(1).map((x) => x.spotifyId).join(">");
    const key = `${a.spotifyId}|${a.text.toLowerCase()}|${restSongs}`;
    const list = byJoin.get(key) || [];
    list.push(c);
    byJoin.set(key, list);
  }

  const kept: Cand[] = [];
  for (const group of byJoin.values()) {
    // Drop chips that are strict prefixes of a longer continuation in the same group
    const survivors = group.filter((c) => {
      const bText = c.chips
        .slice(1)
        .map((x) => x.text.toLowerCase())
        .join(" ");
      return !group.some((other) => {
        if (other === c) return false;
        const otherB = other.chips
          .slice(1)
          .map((x) => x.text.toLowerCase())
          .join(" ");
        return otherB !== bText && otherB.startsWith(bText);
      });
    });
    survivors.sort(
      (x, y) =>
        y.quality - x.quality ||
        words(y.chips.map((c) => c.text).join(" ")).length -
          words(x.chips.map((c) => c.text).join(" ")).length ||
        y.score - x.score,
    );
    if (survivors[0]) kept.push(survivors[0]);
  }
  return kept;
}

/** Rank then pick so one opening lyric / song pair can’t flood the pool. */
function diversifyCandidates(candidates: Cand[]): Cand[] {
  const ranked = [...candidates].sort(
    (a, b) => b.quality - a.quality || b.score - a.score,
  );
  const out: Cand[] = [];
  const openingCount = new Map<string, number>();
  const pairCount = new Map<string, number>();

  for (const c of ranked) {
    const ok = openingKey(c.chips);
    const pk = pairKey(c.chips);
    if ((openingCount.get(ok) || 0) >= MAX_PER_OPENING) continue;
    if ((pairCount.get(pk) || 0) >= MAX_PER_SONG_PAIR) continue;
    out.push(c);
    openingCount.set(ok, (openingCount.get(ok) || 0) + 1);
    pairCount.set(pk, (pairCount.get(pk) || 0) + 1);
    if (out.length >= 400) break;
  }
  return out;
}

export type LyricBoardSongInput = {
  spotify_id_resolved: string;
  artist: string;
  title: string;
  tempo?: number | null;
  tempo_override?: number | null;
  camelot?: string | null;
  camelot_override?: string | null;
};

export async function generateLyricBoardBridges(
  projectId: string,
  opts: GenerateLyricBoardOpts,
): Promise<{ suggestions: LyricBridgeSuggestion[]; nextCursor: number | null; total: number }> {
  const songs = await listSongsForProject(projectId);
  return generateLyricBoardBridgesForScope(projectId, songs, opts);
}

export async function generateLibraryLyricBoardBridges(
  userId: string,
  opts: GenerateLyricBoardOpts,
): Promise<{ suggestions: LyricBridgeSuggestion[]; nextCursor: number | null; total: number }> {
  const tracks = await listLibraryTracks();
  const songs: LyricBoardSongInput[] = tracks.map((t) => ({
    spotify_id_resolved: t.spotify_id,
    artist: t.artist,
    title: t.title,
    tempo: t.tempo,
    camelot: t.camelot,
  }));
  return generateLyricBoardBridgesForScope(libraryBoardScope(userId), songs, opts);
}

export async function generateLyricBoardBridgesForScope(
  scopeKey: string,
  songs: LyricBoardSongInput[],
  opts: GenerateLyricBoardOpts,
): Promise<{ suggestions: LyricBridgeSuggestion[]; nextCursor: number | null; total: number }> {
  const songsPerBridge = opts.songsPerBridge;
  const batchSize = opts.batchSize;
  const { matchKey, matchBpm } = resolveMatchFlags(opts);
  const cursor = Math.max(0, Math.floor(opts.cursor || 0));
  const bpmTol = 12;
  const directionTerms = String(opts.direction || "")
    .toLowerCase()
    .split(/[^a-z0-9']+/)
    .filter((t) => t.length > 2);

  const ids = songs.map((s) => s.spotify_id_resolved).filter(Boolean);
  const lyricsMap = await listLyricsForSpotifyIds(ids);
  const { dismissed } = await getLyricBoard(scopeKey);
  const dismissedSet = new Set(dismissed);

  const contexts: SongCtx[] = [];
  for (const s of songs) {
    if (contexts.length >= MAX_SONG_CONTEXTS) break;
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

  const candidates: Cand[] = [];
  const seen = new Set<string>();

  const pushCand = (
    parts: Array<{ song: SongCtx; phrase: PhraseChip }>,
    score: number,
    match: { ok: boolean; keyMatched: boolean; bpmMatched: boolean },
  ) => {
    if (parts.length !== songsPerBridge) return;
    const idsUsed = new Set(parts.map((p) => p.song.spotifyId));
    if (idsUsed.size !== songsPerBridge) return;
    const chips = parts.map((p) => toBridgeChip(p.song, p.phrase));
    const quality = sentenceQuality(chips);
    if (quality < 0) return;
    const hash = bridgeHash(chips);
    if (seen.has(hash) || dismissedSet.has(hash)) return;
    seen.add(hash);
    candidates.push({
      chips,
      score: score + quality * 0.15,
      keyBpmMatched: match.ok,
      keyMatched: match.keyMatched,
      bpmMatched: match.bpmMatched,
      filters: { key: matchKey, bpm: matchBpm },
      quality,
    });
  };

  // 2-song bridges
  if (songsPerBridge === 2) {
    for (let i = 0; i < contexts.length; i++) {
      for (let j = 0; j < contexts.length; j++) {
        if (i === j) continue;
        const A = contexts[i];
        const B = contexts[j];
        const match = pairMatch(A, B, matchKey, matchBpm, bpmTol);
        if ((matchKey || matchBpm) && !match.ok) continue;
        const suf = A.suffixes.slice(0, 20);
        const pre = B.prefixes.slice(0, 20);
        for (const a of suf) {
          for (const b of pre) {
            const sc = joinScore(a, b, directionTerms);
            if (sc < 4) continue;
            pushCand(
              [
                { song: A, phrase: a },
                { song: B, phrase: b },
              ],
              sc + (match.ok ? 0.5 : 0),
              match,
            );
          }
        }
      }
    }
  } else {
    // 3–4: build from strong 2-joins then extend
    type Edge = {
      a: number;
      b: number;
      ap: PhraseChip;
      bp: PhraseChip;
      score: number;
      match: { ok: boolean; keyMatched: boolean; bpmMatched: boolean };
    };
    const edges: Edge[] = [];
    for (let i = 0; i < contexts.length; i++) {
      for (let j = 0; j < contexts.length; j++) {
        if (i === j) continue;
        const match = pairMatch(contexts[i], contexts[j], matchKey, matchBpm, bpmTol);
        if ((matchKey || matchBpm) && !match.ok) continue;
        for (const a of contexts[i].suffixes.slice(0, 14)) {
          for (const b of contexts[j].prefixes.slice(0, 14)) {
            const sc = joinScore(a, b, directionTerms);
            if (sc < 4.5) continue;
            edges.push({ a: i, b: j, ap: a, bp: b, score: sc, match });
          }
        }
      }
    }
    edges.sort((x, y) => y.score - x.score);
    const topEdges = edges.slice(0, 600);

    for (const e1 of topEdges) {
      if (songsPerBridge === 3) {
        for (const e2 of topEdges) {
          if (e2.a !== e1.b) continue;
          if (e2.b === e1.a || e2.b === e1.b) continue;
          const mid = e1.bp;
          // Middle + final must both be closed continuations
          if (!isClosedContinuation(mid.text) || !isClosedContinuation(e2.bp.text)) continue;
          const sc = e1.score + e2.score;
          const match = {
            ok: e1.match.ok && e2.match.ok,
            keyMatched: e1.match.keyMatched && e2.match.keyMatched,
            bpmMatched: e1.match.bpmMatched && e2.match.bpmMatched,
          };
          pushCand(
            [
              { song: contexts[e1.a], phrase: e1.ap },
              { song: contexts[e1.b], phrase: mid },
              { song: contexts[e2.b], phrase: e2.bp },
            ],
            sc / 2,
            match,
          );
        }
      } else {
        for (const e2 of topEdges) {
          if (e2.a !== e1.b) continue;
          if (new Set([e1.a, e1.b, e2.b]).size < 3) continue;
          for (const e3 of topEdges) {
            if (e3.a !== e2.b) continue;
            const used = new Set([e1.a, e1.b, e2.b, e3.b]);
            if (used.size < 4) continue;
            if (
              !isClosedContinuation(e1.bp.text) ||
              !isClosedContinuation(e2.bp.text) ||
              !isClosedContinuation(e3.bp.text)
            ) {
              continue;
            }
            const sc = e1.score + e2.score + e3.score;
            const match = {
              ok: e1.match.ok && e2.match.ok && e3.match.ok,
              keyMatched:
                e1.match.keyMatched && e2.match.keyMatched && e3.match.keyMatched,
              bpmMatched:
                e1.match.bpmMatched && e2.match.bpmMatched && e3.match.bpmMatched,
            };
            pushCand(
              [
                { song: contexts[e1.a], phrase: e1.ap },
                { song: contexts[e1.b], phrase: e1.bp },
                { song: contexts[e2.b], phrase: e2.bp },
                { song: contexts[e3.b], phrase: e3.bp },
              ],
              sc / 3,
              match,
            );
          }
        }
      }
    }
  }

  const collapsed = collapseNestedDuplicates(candidates);
  const pool = diversifyCandidates(collapsed);
  const slice = pool.slice(cursor, cursor + batchSize);
  const suggestions: LyricBridgeSuggestion[] = slice.map((c) => ({
    hash: bridgeHash(c.chips),
    sentence: c.chips.map((x) => x.text).join(" "),
    chips: c.chips,
    score: c.score,
    keyBpmMatched: c.keyBpmMatched,
    keyMatched: c.keyMatched,
    bpmMatched: c.bpmMatched,
    filters: c.filters,
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
