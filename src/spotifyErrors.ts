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

Song Matcher falls back to ReccoBeats (free, no key) using Spotify track IDs, then FreqBlog / Brizm / GetSongBPM.
If those fail, check network access or set FREQBLOG_API_KEY
(note: GetSongBPM is often blocked by Cloudflare for non-browser clients).`;
