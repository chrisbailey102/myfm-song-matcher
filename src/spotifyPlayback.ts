/**
 * Start playback on a Spotify device (Premium).
 * Pass deviceId to target the Song Matcher in-browser Web Playback SDK player.
 * positionMs seeks into the track — used for lyric bridge previews.
 */
export async function startSpotifyPlayback(
  accessToken: string,
  spotifyId: string,
  positionMs = 0,
  deviceId?: string,
): Promise<void> {
  const url = deviceId
    ? `https://api.spotify.com/v1/me/player/play?device_id=${encodeURIComponent(deviceId)}`
    : "https://api.spotify.com/v1/me/player/play";
  const res = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      uris: [`spotify:track:${spotifyId}`],
      position_ms: Math.max(0, Math.floor(positionMs)),
    }),
  });
  if (res.status === 204 || res.status === 202) return;
  const body = await res.text();
  if (res.status === 404) {
    throw new Error(
      "No active Spotify player. Open the Spotify app (phone or desktop), play anything once, then retry — or reconnect Spotify for in-browser playback.",
    );
  }
  if (res.status === 403) {
    throw new Error(
      "Spotify playback forbidden (Premium required for full playback, or re-connect Spotify to grant playback scopes).",
    );
  }
  if (res.status === 401) {
    const err = new Error(
      "Spotify permissions missing — log out and Connect Spotify again to allow playback control.",
    );
    (err as Error & { code?: string }).code = "needs_reauth";
    throw err;
  }
  throw new Error(`Spotify play failed: ${res.status} ${body}`);
}

/** Pause playback on the user's active Spotify device. */
export async function pauseSpotifyPlayback(accessToken: string): Promise<void> {
  const res = await fetch("https://api.spotify.com/v1/me/player/pause", {
    method: "PUT",
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (res.status === 204 || res.status === 202 || res.status === 200) return;
  const body = await res.text();
  if (res.status === 404) {
    throw new Error("No active Spotify player to pause.");
  }
  if (res.status === 403) {
    throw new Error(
      "Spotify pause forbidden (Premium required, or re-connect Spotify for playback scopes).",
    );
  }
  if (res.status === 401) {
    const err = new Error(
      "Spotify permissions missing — log out and Connect Spotify again to allow playback control.",
    );
    (err as Error & { code?: string }).code = "needs_reauth";
    throw err;
  }
  throw new Error(`Spotify pause failed: ${res.status} ${body}`);
}

/** Seek the active Spotify player (Premium). */
export async function seekSpotifyPlayback(
  accessToken: string,
  positionMs: number,
  deviceId?: string,
): Promise<void> {
  const ms = Math.max(0, Math.floor(positionMs));
  const q = new URLSearchParams({ position_ms: String(ms) });
  if (deviceId) q.set("device_id", deviceId);
  const res = await fetch(`https://api.spotify.com/v1/me/player/seek?${q}`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (res.status === 204 || res.status === 202 || res.status === 200) return;
  const body = await res.text();
  if (res.status === 404) {
    throw new Error("No active Spotify player to seek.");
  }
  throw new Error(`Spotify seek failed: ${res.status} ${body}`);
}

/** Set volume on the active Spotify player (0–100). */
export async function setSpotifyVolume(
  accessToken: string,
  volumePercent: number,
  deviceId?: string,
): Promise<void> {
  const vol = Math.max(0, Math.min(100, Math.round(volumePercent)));
  const q = new URLSearchParams({ volume_percent: String(vol) });
  if (deviceId) q.set("device_id", deviceId);
  const res = await fetch(`https://api.spotify.com/v1/me/player/volume?${q}`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (res.status === 204 || res.status === 202 || res.status === 200) return;
  const body = await res.text();
  if (res.status === 404) {
    throw new Error("No active Spotify player for volume.");
  }
  throw new Error(`Spotify volume failed: ${res.status} ${body}`);
}

/** 30s preview MP3 when Spotify still provides one (often null nowadays). */
export async function fetchTrackPreviewUrl(
  accessToken: string,
  spotifyId: string,
): Promise<string | null> {
  const res = await fetch(
    `https://api.spotify.com/v1/tracks/${encodeURIComponent(spotifyId)}?market=from_token`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (!res.ok) return null;
  const j = (await res.json()) as { preview_url?: string | null };
  return j.preview_url ?? null;
}

export function spotifyOpenUrl(spotifyId: string, positionMs = 0): string {
  const t = Math.max(0, Math.floor(positionMs / 1000));
  const base = `https://open.spotify.com/track/${spotifyId}`;
  return t > 0 ? `${base}?t=${t}` : base;
}
