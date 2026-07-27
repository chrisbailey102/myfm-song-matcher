import { spotifyKeyModeToCamelot } from "./camelot.js";

export type ReccoTrackMeta = {
  tempo: number;
  camelot: string;
  spotify_key: number;
  spotify_mode: number;
  time_signature: number;
  energy: number;
  danceability: number;
  bpm_key_source: "reccobeats";
};

type ReccoFeatures = {
  href?: string;
  key?: number;
  mode?: number;
  tempo?: number;
  energy?: number;
  danceability?: number;
};

function spotifyIdFromHref(href: string | undefined): string | null {
  if (!href) return null;
  const m = /track\/([a-zA-Z0-9]+)/.exec(href);
  return m?.[1] ?? null;
}

/**
 * Free Spotify-ID → audio features (tempo/key/mode). No API key.
 * https://reccobeats.com/
 */
export async function fetchReccoBeatsFeatures(
  spotifyIds: string[],
): Promise<Map<string, ReccoTrackMeta>> {
  const out = new Map<string, ReccoTrackMeta>();
  const chunk = 20;
  for (let i = 0; i < spotifyIds.length; i += chunk) {
    const slice = spotifyIds.slice(i, i + chunk);
    const params = new URLSearchParams({ ids: slice.join(",") });
    const res = await fetch(
      `https://api.reccobeats.com/v1/audio-features?${params.toString()}`,
      {
        headers: {
          Accept: "application/json",
          "User-Agent":
            "MyFMSongMatcher/0.1 (+https://github.com/chrisbailey102/myfm-song-matcher)",
        },
      },
    );
    if (!res.ok) {
      throw new Error(`ReccoBeats audio-features failed: ${res.status} ${await res.text()}`);
    }
    const data = (await res.json()) as { content?: ReccoFeatures[] };
    for (const af of data.content ?? []) {
      const id = spotifyIdFromHref(af.href);
      if (!id) continue;
      const key = af.key ?? -1;
      const mode = af.mode ?? -1;
      const tempo = Number(af.tempo) || 0;
      if (!tempo) continue;
      const camelot =
        key >= 0 && key <= 11 && (mode === 0 || mode === 1)
          ? spotifyKeyModeToCamelot(key, mode)
          : "";
      out.set(id, {
        tempo,
        camelot,
        spotify_key: key,
        spotify_mode: mode,
        time_signature: 4,
        energy: af.energy ?? 0,
        danceability: af.danceability ?? 0,
        bpm_key_source: "reccobeats",
      });
    }
    if (i + chunk < spotifyIds.length) {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  return out;
}
