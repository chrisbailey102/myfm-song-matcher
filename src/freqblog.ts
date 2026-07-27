import { parseCamelot, spotifyKeyModeToCamelot } from "./camelot.js";

export type FreqBlogTrackMeta = {
  tempo: number;
  camelot: string;
  spotify_key: number;
  spotify_mode: number;
  time_signature: number;
  energy: number;
  danceability: number;
  bpm_key_source: "freqblog";
};

type FreqBlogLookup = {
  spotifyId?: string;
  isrc?: string;
  artist: string;
  title: string;
};

type FreqBlogResponse = {
  bpm?: number;
  camelot?: string;
  key_int?: number;
  mode?: number;
  key?: string;
  energy?: number;
  danceability?: number;
  time_signature?: number;
  detail?: string;
  backfill_status?: string | null;
};

/**
 * Catalog BPM/key/energy via FreqBlog (artist+title, ISRC, or Spotify ID).
 * https://freqblog.com/
 */
export async function fetchFreqBlogMeta(
  lookup: FreqBlogLookup,
  apiKey: string,
): Promise<FreqBlogTrackMeta | null> {
  const headers = {
    Accept: "application/json",
    "X-API-Key": apiKey,
    "User-Agent":
      "SongMatcher/0.1 (+https://github.com/chrisbailey102/myfm-song-matcher)",
  };

  const attempts: URLSearchParams[] = [];
  if (lookup.artist && lookup.title) {
    attempts.push(
      new URLSearchParams({ track: lookup.title, artist: lookup.artist }),
    );
  }
  if (lookup.isrc?.trim()) {
    attempts.push(new URLSearchParams({ isrc: lookup.isrc.trim() }));
  }
  if (lookup.spotifyId?.trim()) {
    attempts.push(new URLSearchParams({ spotify_id: lookup.spotifyId.trim() }));
  }

  for (const params of attempts) {
    const meta = await tryLookup(params, headers);
    if (meta) return meta;
  }
  return null;
}

async function tryLookup(
  params: URLSearchParams,
  headers: Record<string, string>,
): Promise<FreqBlogTrackMeta | null> {
  let res: Response;
  try {
    res = await fetch(`https://api.freqblog.com/lookup?${params.toString()}`, {
      headers,
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    return null;
  }
  if (res.status === 202) return null; // queued backfill — retry later
  if (!res.ok) return null;
  const data = (await res.json()) as FreqBlogResponse;
  return metaFromFreqBlog(data);
}

function metaFromFreqBlog(data: FreqBlogResponse): FreqBlogTrackMeta | null {
  const tempo = Number(data.bpm) || 0;
  if (!tempo) return null;

  let camelot = normalizeCamelot(data.camelot);
  let spotify_key = Number.isFinite(data.key_int) ? Number(data.key_int) : -1;
  let spotify_mode =
    data.mode === 0 || data.mode === 1 ? data.mode : -1;

  if (!camelot && spotify_key >= 0 && spotify_mode >= 0) {
    camelot = spotifyKeyModeToCamelot(spotify_key, spotify_mode);
  }
  if (!camelot && data.key) {
    const km = keyFromLabel(data.key);
    if (km) {
      spotify_key = km.key;
      spotify_mode = km.mode;
      camelot = spotifyKeyModeToCamelot(km.key, km.mode);
    }
  }

  return {
    tempo: Math.round(tempo),
    camelot,
    spotify_key,
    spotify_mode,
    time_signature: Number(data.time_signature) || 4,
    energy: normalizeUnit(data.energy),
    danceability: normalizeUnit(data.danceability),
    bpm_key_source: "freqblog",
  };
}

function normalizeUnit(n: number | undefined): number {
  if (n == null || !Number.isFinite(n)) return 0;
  if (n > 1) return Math.min(1, n / 100);
  if (n < 0) return 0;
  return n;
}

function normalizeCamelot(raw: string | undefined): string {
  if (!raw) return "";
  const c = raw.trim().toUpperCase().replace(/\s+/g, "");
  return parseCamelot(c) ? c : "";
}

/** e.g. "F-Minor", "C# Major" */
function keyFromLabel(raw: string): { key: number; mode: number } | null {
  const m = /^([A-G](?:#|b)?)\s*[- ]?\s*(major|minor|maj|min|m)?$/i.exec(
    raw.trim().replace(/_/g, " "),
  );
  if (!m) return null;
  const pitchMap: Record<string, number> = {
    C: 0,
    "C#": 1,
    Db: 1,
    D: 2,
    "D#": 3,
    Eb: 3,
    E: 4,
    F: 5,
    "F#": 6,
    Gb: 6,
    G: 7,
    "G#": 8,
    Ab: 8,
    A: 9,
    "A#": 10,
    Bb: 10,
    B: 11,
  };
  const pitch = pitchMap[m[1]];
  if (pitch === undefined) return null;
  const modeStr = (m[2] || "major").toLowerCase();
  const minor = /^(m|min|minor)$/.test(modeStr);
  return { key: pitch, mode: minor ? 0 : 1 };
}
