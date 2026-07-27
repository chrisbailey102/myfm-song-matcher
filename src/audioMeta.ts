import type { CatalogRow } from "./types.js";
import type { SpotifyTrack, SpotifyAudioFeatures } from "./spotify.js";
import { getAudioFeatures } from "./spotify.js";
import { spotifyKeyModeToCamelot } from "./camelot.js";
import {
  isSpotifyAudioFeaturesForbidden,
  SPOTIFY_AUDIO_FEATURES_HELP,
} from "./spotifyErrors.js";
import { optionalEnv } from "./config.js";
import { fetchGetSongBpmMeta } from "./getsongbpm.js";
import { fetchReccoBeatsFeatures } from "./reccobeats.js";

export type ResolvedTrack = {
  row: CatalogRow;
  track: SpotifyTrack;
};

export type TrackAudioMeta = {
  tempo: number;
  camelot: string;
  spotify_key: number;
  spotify_mode: number;
  time_signature: number;
  energy: number;
  danceability: number;
  bpm_key_source: "spotify" | "reccobeats" | "getsongbpm" | "";
};

function metaFromSpotify(af: SpotifyAudioFeatures): TrackAudioMeta {
  const key = af.key;
  const mode = af.mode;
  const camelot =
    key >= 0 && key <= 11 && (mode === 0 || mode === 1)
      ? spotifyKeyModeToCamelot(key, mode)
      : "";
  return {
    tempo: af.tempo ?? 0,
    camelot,
    spotify_key: key,
    spotify_mode: mode,
    time_signature: af.time_signature ?? 0,
    energy: af.energy ?? 0,
    danceability: af.danceability ?? 0,
    bpm_key_source: "spotify",
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * BPM + key for each Spotify track id.
 * Order: Spotify audio-features → ReccoBeats → GetSongBPM (per-title).
 */
export async function resolveTrackAudioMeta(
  resolved: ResolvedTrack[],
  onStatus?: (msg: string) => void,
): Promise<Map<string, TrackAudioMeta>> {
  const out = new Map<string, TrackAudioMeta>();
  const ids = [...new Set(resolved.map((x) => x.track.id))];

  try {
    const spotify = await getAudioFeatures(ids);
    for (const [id, af] of spotify) {
      if (af) out.set(id, metaFromSpotify(af));
    }
    if (out.size > 0) return out;
  } catch (err) {
    if (!isSpotifyAudioFeaturesForbidden(err)) throw err;
    onStatus?.(
      "Spotify audio-features returned 403 (normal for new apps). Trying ReccoBeats…",
    );
  }

  try {
    const recco = await fetchReccoBeatsFeatures(ids);
    for (const [id, meta] of recco) out.set(id, meta);
    onStatus?.(`ReccoBeats: got BPM/key for ${out.size}/${ids.length} tracks`);
  } catch (err) {
    onStatus?.(
      `ReccoBeats failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const missing = ids.filter((id) => !out.has(id));
  if (missing.length === 0) return out;

  const apiKey = optionalEnv("GETSONGBPM_API_KEY")?.trim();
  if (!apiKey) {
    if (out.size === 0) throw new Error(SPOTIFY_AUDIO_FEATURES_HELP);
    onStatus?.(
      `Skipping GetSongBPM for ${missing.length} missing tracks (no GETSONGBPM_API_KEY).`,
    );
    return out;
  }

  const byId = new Map<string, ResolvedTrack>();
  for (const r of resolved) byId.set(r.track.id, r);

  let i = 0;
  for (const id of missing) {
    i++;
    const row = byId.get(id)?.row;
    if (!row) continue;
    onStatus?.(`[GetSongBPM ${i}/${missing.length}] ${row.artist} — ${row.title}`);
    const g = await fetchGetSongBpmMeta(row.artist, row.title, apiKey);
    if (g) {
      out.set(id, {
        tempo: g.tempo,
        camelot: g.camelot,
        spotify_key: -1,
        spotify_mode: -1,
        time_signature: g.time_signature,
        energy: 0,
        danceability: 0,
        bpm_key_source: "getsongbpm",
      });
    }
    await sleep(350);
  }

  if (out.size === 0) {
    throw new Error(
      "No BPM/key data from Spotify, ReccoBeats, or GetSongBPM. " +
        "GetSongBPM may be blocked by Cloudflare from servers — ReccoBeats is preferred.",
    );
  }

  return out;
}
