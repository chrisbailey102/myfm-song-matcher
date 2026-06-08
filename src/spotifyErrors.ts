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

Fix options:
  1. Add a free GetSongBPM API key to .env or spotify-key.env:
       GETSONGBPM_API_KEY=your_key
     Register at https://getsongbpm.com/api
  2. Or request extended Spotify Web API access in the Spotify Developer Dashboard
     (see https://developer.spotify.com/blog/2024-11-27-changes-to-the-web-api)`;
