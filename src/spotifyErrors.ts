export class SpotifyApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly path: string,
    public readonly body: string,
  ) {
    super(`Spotify GET ${path}: ${status} ${body}`);
    this.name = "SpotifyApiError";
  }
}

export function isSpotifyAudioFeaturesForbidden(err: unknown): boolean {
  if (!(err instanceof SpotifyApiError)) return false;
  return err.status === 403 && err.path.includes("audio-features");
}

export const SPOTIFY_AUDIO_FEATURES_HELP = `Spotify blocked "audio-features" for newer developer apps (since Nov 2024).

MyFM falls back to ReccoBeats (free, no key) using Spotify track IDs, then optionally GetSongBPM.
If both fail, check network access to https://api.reccobeats.com or set GETSONGBPM_API_KEY
(note: GetSongBPM is often blocked by Cloudflare for non-browser clients).`;
