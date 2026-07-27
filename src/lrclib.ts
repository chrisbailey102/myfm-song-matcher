import { parseLrcLines } from "./lyricClean.js";

const UA =
  "MyFMSongMatcher/0.1 (https://github.com/chrisbailey102/myfm-song-matcher)";

export type LrcLibTrack = {
  id: number;
  trackName: string;
  artistName: string;
  albumName?: string;
  duration: number;
  instrumental: boolean;
  plainLyrics: string | null;
  syncedLyrics: string | null;
};

export type TimedLine = {
  startMs: number;
  text: string;
};

/**
 * Fetch timed/plain lyrics from LRCLIB (free, no API key).
 * https://lrclib.net/docs
 */
export async function fetchLrcLib(
  artist: string,
  title: string,
  durationSec?: number,
): Promise<LrcLibTrack | null> {
  const params = new URLSearchParams({
    artist_name: cleanArtist(artist),
    track_name: cleanTitle(title),
  });
  if (durationSec && durationSec > 0) {
    params.set("duration", String(Math.round(durationSec)));
  }
  const res = await fetch(`https://lrclib.net/api/get?${params.toString()}`, {
    headers: { "User-Agent": UA, Accept: "application/json" },
  });
  if (res.status === 404) {
    return searchFallback(artist, title);
  }
  if (!res.ok) return null;
  const data = (await res.json()) as LrcLibTrack;
  if (!data.plainLyrics && !data.syncedLyrics) return searchFallback(artist, title);
  return data;
}

async function searchFallback(
  artist: string,
  title: string,
): Promise<LrcLibTrack | null> {
  const params = new URLSearchParams({
    q: `${cleanArtist(artist)} ${cleanTitle(title)}`,
  });
  const res = await fetch(`https://lrclib.net/api/search?${params.toString()}`, {
    headers: { "User-Agent": UA, Accept: "application/json" },
  });
  if (!res.ok) return null;
  const hits = (await res.json()) as LrcLibTrack[];
  if (!Array.isArray(hits) || hits.length === 0) return null;
  const best = hits.find((h) => h.syncedLyrics || h.plainLyrics) ?? hits[0];
  if (!best?.id) return null;
  if (best.plainLyrics || best.syncedLyrics) return best;
  const getRes = await fetch(`https://lrclib.net/api/get/${best.id}`, {
    headers: { "User-Agent": UA, Accept: "application/json" },
  });
  if (!getRes.ok) return best;
  return (await getRes.json()) as LrcLibTrack;
}

function cleanArtist(artist: string): string {
  return artist.split(/[;/]/)[0].replace(/\s+/g, " ").trim();
}

function cleanTitle(title: string): string {
  return title
    .replace(/\s*\([^)]*\)\s*/g, " ")
    .replace(/\s*\[[^\]]*\]\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function timedLinesFromLrcLib(track: LrcLibTrack): TimedLine[] {
  if (track.syncedLyrics) return parseLrcLines(track.syncedLyrics);
  if (track.plainLyrics) {
    return track.plainLyrics
      .split(/\n+/)
      .map((t) => t.trim())
      .filter(Boolean)
      .map((text) => ({ startMs: -1, text }));
  }
  return [];
}

export function plainTextFromLrcLib(track: LrcLibTrack): string {
  if (track.plainLyrics?.trim()) return track.plainLyrics.trim();
  if (track.syncedLyrics) {
    return parseLrcLines(track.syncedLyrics)
      .map((l) => l.text)
      .join("\n");
  }
  return "";
}
