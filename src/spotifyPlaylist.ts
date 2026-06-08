import type { CatalogRow } from "./types.js";

export function parsePlaylistId(urlOrId: string): string {
  const s = urlOrId.trim();
  if (s.startsWith("spotify:playlist:")) return s.split(":")[2];
  const m = /playlist\/([a-zA-Z0-9]+)/.exec(s);
  if (m) return m[1];
  if (/^[a-zA-Z0-9]{10,}$/.test(s)) return s;
  throw new Error("Invalid Spotify playlist URL or ID.");
}

type PlaylistTrackItem = {
  track: {
    id: string;
    name: string;
    duration_ms: number;
    popularity: number;
    external_urls: { spotify: string };
    artists: { name: string }[];
    album: { release_date: string };
  } | null;
};

type PlaylistResponse = {
  name: string;
  external_urls: { spotify: string };
  tracks: {
    items: PlaylistTrackItem[];
    next: string | null;
  };
};

export async function fetchPlaylistMeta(
  accessToken: string,
  playlistId: string,
): Promise<{ id: string; name: string; url: string }> {
  const res = await fetch(`https://api.spotify.com/v1/playlists/${playlistId}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`Playlist fetch failed: ${res.status} ${await res.text()}`);
  const p = (await res.json()) as PlaylistResponse;
  return {
    id: playlistId,
    name: p.name,
    url: p.external_urls.spotify,
  };
}

export async function fetchPlaylistTracks(
  accessToken: string,
  playlistId: string,
): Promise<CatalogRow[]> {
  const rows: CatalogRow[] = [];
  let url: string | null =
    `https://api.spotify.com/v1/playlists/${playlistId}/tracks?limit=50&market=US`;

  while (url) {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) throw new Error(`Playlist tracks failed: ${res.status} ${await res.text()}`);
    const data = (await res.json()) as PlaylistResponse["tracks"] & { name?: string };
    for (const item of data.items) {
      const t = item.track;
      if (!t?.id) continue;
      const year = t.album?.release_date?.slice(0, 4);
      rows.push({
        artist: t.artists.map((a) => a.name).join("; "),
        title: t.name,
        year: year || undefined,
        spotify_id: t.id,
      });
    }
    url = data.next;
  }

  if (rows.length === 0) {
    throw new Error("Playlist has no playable tracks.");
  }
  return rows;
}

export type UserPlaylistSummary = {
  id: string;
  name: string;
  url: string;
  track_count: number;
};

export async function fetchUserPlaylists(
  accessToken: string,
  limit = 30,
): Promise<UserPlaylistSummary[]> {
  const out: UserPlaylistSummary[] = [];
  let url: string | null = `https://api.spotify.com/v1/me/playlists?limit=${Math.min(limit, 50)}`;

  while (url && out.length < limit) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!res.ok) throw new Error(`User playlists failed: ${await res.text()}`);
    const data = (await res.json()) as {
      items: Array<{
        id: string;
        name: string;
        external_urls: { spotify: string };
        tracks: { total: number };
      }>;
      next: string | null;
    };
    for (const p of data.items) {
      out.push({
        id: p.id,
        name: p.name,
        url: p.external_urls.spotify,
        track_count: p.tracks.total,
      });
      if (out.length >= limit) break;
    }
    url = data.next;
  }
  return out;
}
