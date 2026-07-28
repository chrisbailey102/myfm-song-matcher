import type { CatalogRow } from "./types.js";
import type { SpotifyTrack, SpotifyAudioFeatures } from "./spotify.js";
import { getAudioFeatures } from "./spotify.js";
import { spotifyKeyModeToCamelot } from "./camelot.js";
import {
  isSpotifyAudioFeaturesForbidden,
} from "./spotifyErrors.js";
import { optionalEnv } from "./config.js";
import { fetchGetSongBpmMeta } from "./getsongbpm.js";
import { fetchReccoBeatsFeatures } from "./reccobeats.js";
import { fetchBrizmMeta } from "./brizm.js";
import { fetchFreqBlogMeta } from "./freqblog.js";

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
  bpm_key_source: "spotify" | "reccobeats" | "freqblog" | "brizm" | "getsongbpm" | "";
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

function hasTempo(m: TrackAudioMeta | undefined): boolean {
  return Boolean(m?.tempo);
}

function hasEnergy(m: TrackAudioMeta | undefined): boolean {
  return Boolean(m && m.energy > 0);
}

/** Complete enough to stop looking: BPM plus energy when sources can provide it. */
function isComplete(m: TrackAudioMeta | undefined): boolean {
  return hasTempo(m) && hasEnergy(m);
}

function needsMoreMeta(m: TrackAudioMeta | undefined): boolean {
  return !isComplete(m);
}

/** Keep good BPM/key; fill energy/danceability gaps from a later source. */
function mergeMeta(
  prev: TrackAudioMeta | undefined,
  next: TrackAudioMeta,
): TrackAudioMeta {
  if (!prev) return next;
  return {
    tempo: prev.tempo > 0 ? prev.tempo : next.tempo,
    camelot: prev.camelot || next.camelot,
    spotify_key: prev.spotify_key >= 0 ? prev.spotify_key : next.spotify_key,
    spotify_mode: prev.spotify_mode >= 0 ? prev.spotify_mode : next.spotify_mode,
    time_signature: prev.time_signature || next.time_signature,
    energy: prev.energy > 0 ? prev.energy : next.energy,
    danceability: prev.danceability > 0 ? prev.danceability : next.danceability,
    bpm_key_source:
      prev.tempo > 0 ? prev.bpm_key_source : next.bpm_key_source,
  };
}

/**
 * BPM + key (+ energy when available) for each Spotify track id.
 * Order: Spotify → ReccoBeats → FreqBlog → Brizm → GetSongBPM.
 * Later sources can fill energy without overwriting a good BPM/key.
 */
export async function resolveTrackAudioMeta(
  resolved: ResolvedTrack[],
  onStatus?: (msg: string) => void,
): Promise<Map<string, TrackAudioMeta>> {
  const out = new Map<string, TrackAudioMeta>();
  const ids = [...new Set(resolved.map((x) => x.track.id))];
  const byId = new Map<string, ResolvedTrack>();
  for (const r of resolved) byId.set(r.track.id, r);

  try {
    const spotify = await getAudioFeatures(ids);
    for (const [id, af] of spotify) {
      if (af) out.set(id, metaFromSpotify(af));
    }
    if (ids.every((id) => isComplete(out.get(id)))) return out;
  } catch (err) {
    if (!isSpotifyAudioFeaturesForbidden(err)) throw err;
    onStatus?.(
      "Spotify audio-features returned 403 (normal for new apps). Trying ReccoBeats…",
    );
  }

  const needAfterSpotify = ids.filter((id) => needsMoreMeta(out.get(id)));
  if (needAfterSpotify.length > 0) {
    try {
      const recco = await fetchReccoBeatsFeatures(needAfterSpotify);
      for (const [id, meta] of recco) out.set(id, mergeMeta(out.get(id), meta));
      onStatus?.(
        `ReccoBeats: got BPM/key for ${[...out.values()].filter((m) => m.bpm_key_source === "reccobeats").length}/${needAfterSpotify.length} missing tracks`,
      );
    } catch (err) {
      onStatus?.(
        `ReccoBeats failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const missingAfterRecco = ids.filter((id) => needsMoreMeta(out.get(id)));
  if (missingAfterRecco.length > 0) {
    // FreqBlog keys often live in FREQBLOG_API_KEY; also accept BRIZM_API_KEY
    // when the user pasted a FreqBlog sk_live_ key there.
    const freqKey =
      optionalEnv("FREQBLOG_API_KEY")?.trim() ||
      optionalEnv("BRIZM_API_KEY")?.trim();
    if (!freqKey) {
      onStatus?.(
        `Skipping FreqBlog for ${missingAfterRecco.length} missing tracks (no FREQBLOG_API_KEY).`,
      );
    } else {
      let filled = 0;
      let i = 0;
      for (const id of missingAfterRecco) {
        i++;
        const r = byId.get(id);
        if (!r) continue;
        onStatus?.(
          `[FreqBlog ${i}/${missingAfterRecco.length}] ${r.row.artist} — ${r.row.title}`,
        );
        const meta = await fetchFreqBlogMeta(
          {
            spotifyId: id,
            isrc: r.track.external_ids?.isrc || r.row.isrc,
            artist: r.row.artist,
            title: r.row.title,
          },
          freqKey,
        );
        if (meta) {
          out.set(id, mergeMeta(out.get(id), meta));
          filled++;
        }
        await sleep(150);
      }
      onStatus?.(
        `FreqBlog: filled ${filled}/${missingAfterRecco.length} missing tracks`,
      );
    }
  }

  const missingAfterFreq = ids.filter((id) => needsMoreMeta(out.get(id)));
  if (missingAfterFreq.length > 0) {
    const brizmKey = optionalEnv("BRIZM_API_KEY")?.trim();
    // Skip Brizm when the same key is a FreqBlog sk_live_ key (already tried).
    const looksLikeFreqBlog = brizmKey?.startsWith("sk_live_");
    if (!brizmKey || looksLikeFreqBlog) {
      if (brizmKey && looksLikeFreqBlog) {
        /* FreqBlog key reused — Brizm would 401 */
      } else {
        onStatus?.(
          `Skipping Brizm for ${missingAfterFreq.length} missing tracks (no BRIZM_API_KEY).`,
        );
      }
    } else {
      let filled = 0;
      let i = 0;
      for (const id of missingAfterFreq) {
        i++;
        const r = byId.get(id);
        if (!r) continue;
        onStatus?.(
          `[Brizm ${i}/${missingAfterFreq.length}] ${r.row.artist} — ${r.row.title}`,
        );
        const meta = await fetchBrizmMeta(
          {
            spotifyId: id,
            isrc: r.track.external_ids?.isrc || r.row.isrc,
            artist: r.row.artist,
            title: r.row.title,
          },
          brizmKey,
        );
        if (meta) {
          out.set(id, mergeMeta(out.get(id), meta));
          filled++;
        }
        await sleep(200);
      }
      onStatus?.(`Brizm: filled ${filled}/${missingAfterFreq.length} missing tracks`);
    }
  }

  // GetSongBPM only helps BPM/key — skip tracks that already have tempo.
  const missing = ids.filter((id) => !hasTempo(out.get(id)));
  if (missing.length === 0) return out;

  const apiKey = optionalEnv("GETSONGBPM_API_KEY")?.trim();
  if (!apiKey) {
    if (out.size === 0) {
      onStatus?.(
        "No BPM/key yet (Spotify blocked; ReccoBeats/FreqBlog/Brizm empty; no GETSONGBPM_API_KEY). Continuing without BPM.",
      );
    } else {
      onStatus?.(
        `Skipping GetSongBPM for ${missing.length} missing tracks (no GETSONGBPM_API_KEY).`,
      );
    }
    return out;
  }

  let i = 0;
  for (const id of missing) {
    i++;
    const row = byId.get(id)?.row;
    if (!row) continue;
    onStatus?.(`[GetSongBPM ${i}/${missing.length}] ${row.artist} — ${row.title}`);
    const g = await fetchGetSongBpmMeta(row.artist, row.title, apiKey);
    if (g) {
      out.set(
        id,
        mergeMeta(out.get(id), {
          tempo: g.tempo,
          camelot: g.camelot,
          spotify_key: -1,
          spotify_mode: -1,
          time_signature: g.time_signature,
          energy: 0,
          danceability: 0,
          bpm_key_source: "getsongbpm",
        }),
      );
    }
    await sleep(350);
  }

  if (out.size === 0) {
    onStatus?.(
      "No BPM/key from Spotify, ReccoBeats, FreqBlog, Brizm, or GetSongBPM — continuing; you can set overrides in the UI.",
    );
  }

  return out;
}
