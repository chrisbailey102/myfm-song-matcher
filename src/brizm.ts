import { parseCamelot, spotifyKeyModeToCamelot } from "./camelot.js";

export type BrizmTrackMeta = {
  tempo: number;
  camelot: string;
  spotify_key: number;
  spotify_mode: number;
  time_signature: number;
  energy: number;
  danceability: number;
  bpm_key_source: "brizm";
};

type BrizmNative = {
  tempo?: number;
  key?: string;
  mode?: string;
  camelot?: string;
  energy?: number;
  danceability?: number;
  time_signature?: number;
};

type BrizmSpotifyShape = {
  id?: string;
  key?: number;
  mode?: number;
  tempo?: number;
  time_signature?: number;
  energy?: number;
  danceability?: number;
};

export type BrizmLookup = {
  spotifyId: string;
  isrc?: string;
  artist: string;
  title: string;
};

/**
 * Catalog BPM/key/energy via Brizm (Spotify-ID, ISRC, or artist+title).
 * https://developers.brizm.dev/
 */
export async function fetchBrizmMeta(
  lookup: BrizmLookup,
  apiKey: string,
): Promise<BrizmTrackMeta | null> {
  const headers = {
    Accept: "application/json",
    Authorization: `Bearer ${apiKey}`,
    "User-Agent":
      "SongMatcher/0.1 (+https://github.com/chrisbailey102/myfm-song-matcher)",
  };

  // Prefer Spotify ID with Spotify-shaped response (energy 0–1).
  if (lookup.spotifyId) {
    const byId = await trySpotifyShape(
      `https://api.brizm.dev/v1/audio-features/${encodeURIComponent(lookup.spotifyId)}?format=spotify`,
      headers,
    );
    if (byId) return byId;
  }

  if (lookup.isrc?.trim()) {
    const byIsrc = await trySpotifyShape(
      `https://api.brizm.dev/v1/audio-features/${encodeURIComponent(lookup.isrc.trim())}?format=spotify`,
      headers,
    );
    if (byIsrc) return byIsrc;
  }

  if (lookup.artist && lookup.title) {
    const params = new URLSearchParams({
      song: lookup.title,
      artist: lookup.artist,
    });
    const native = await tryNative(
      `https://api.brizm.dev/v1/audio-features?${params.toString()}`,
      headers,
    );
    if (native) return native;
  }

  return null;
}

async function trySpotifyShape(
  url: string,
  headers: Record<string, string>,
): Promise<BrizmTrackMeta | null> {
  let res: Response;
  try {
    res = await fetch(url, { headers, signal: AbortSignal.timeout(12_000) });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  const af = (await res.json()) as BrizmSpotifyShape;
  return metaFromSpotifyShape(af);
}

async function tryNative(
  url: string,
  headers: Record<string, string>,
): Promise<BrizmTrackMeta | null> {
  let res: Response;
  try {
    res = await fetch(url, { headers, signal: AbortSignal.timeout(12_000) });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  const data = (await res.json()) as BrizmNative;
  return metaFromNative(data);
}

function metaFromSpotifyShape(af: BrizmSpotifyShape): BrizmTrackMeta | null {
  const tempo = Number(af.tempo) || 0;
  if (!tempo) return null;
  const key = af.key ?? -1;
  const mode = af.mode ?? -1;
  const camelot =
    key >= 0 && key <= 11 && (mode === 0 || mode === 1)
      ? spotifyKeyModeToCamelot(key, mode)
      : "";
  return {
    tempo: Math.round(tempo),
    camelot,
    spotify_key: key,
    spotify_mode: mode,
    time_signature: af.time_signature ?? 4,
    energy: normalizeUnit(af.energy),
    danceability: normalizeUnit(af.danceability),
    bpm_key_source: "brizm",
  };
}

function metaFromNative(data: BrizmNative): BrizmTrackMeta | null {
  const tempo = Number(data.tempo) || 0;
  if (!tempo) return null;
  let camelot = normalizeCamelot(data.camelot);
  let spotify_key = -1;
  let spotify_mode = -1;
  if (!camelot && data.key) {
    const km = keyModeFromBrizm(data.key, data.mode);
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
    bpm_key_source: "brizm",
  };
}

/** Brizm native energy is often 0–100; Spotify shape is 0–1. */
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

function keyModeFromBrizm(
  keyRaw: string,
  modeRaw: string | undefined,
): { key: number; mode: number } | null {
  const s = keyRaw.trim();
  const m = /^([A-G](?:#|b)?)(?:\s*[- ]?\s*(m|min|minor|maj|major))?$/i.exec(s);
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
  const modeStr = (modeRaw || m[2] || "major").toLowerCase();
  const minor = /^(m|min|minor)$/.test(modeStr);
  return { key: pitch, mode: minor ? 0 : 1 };
}
