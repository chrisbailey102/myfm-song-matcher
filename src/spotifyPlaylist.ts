import type { CatalogRow } from "./types.js";

export function parsePlaylistId(urlOrId: string): string {
  const s = urlOrId.trim();
  if (s.startsWith("spotify:playlist:")) return s.split(":")[2];
  const m = /playlist\/([a-zA-Z0-9]+)/.exec(s);
  if (m) return m[1];
  if (/^[a-zA-Z0-9]{10,}$/.test(s)) return s;
  throw new Error("Invalid Spotify playlist URL or ID.");
}

/** Spotify Dev Mode (Feb 2026+): playlist rows use `item`; older/extended apps use `track`. */
type PlaylistTrack = {
  id: string;
  name: string;
  type?: string;
  duration_ms?: number;
  popularity?: number;
  external_urls?: { spotify?: string };
  external_ids?: { isrc?: string };
  artists?: { name: string }[];
  album?: { release_date?: string };
};

type PlaylistItemRow = {
  track?: PlaylistTrack | null;
  item?: PlaylistTrack | null;
};

type PlaylistPaging = {
  items: PlaylistItemRow[];
  next: string | null;
  total?: number;
};

type PlaylistResponse = {
  name: string;
  external_urls: { spotify: string };
  /** Pre-2026 field name */
  tracks?: PlaylistPaging;
  /** Post-2026 Dev Mode field name */
  items?: PlaylistPaging;
};

function playlistItemAsTrack(row: PlaylistItemRow): PlaylistTrack | null {
  const t = row.item ?? row.track ?? null;
  if (!t?.id) return null;
  if (t.type && t.type !== "track") return null;
  return t;
}

function forbiddenPlaylistMessage(status: number, body: string): string {
  if (status !== 403) return `Playlist tracks failed: ${status} ${body}`;
  return (
    "Spotify forbids reading this playlist’s tracks (HTTP 403). " +
    "Since Feb 2026, Development Mode apps can only load playlists you own or collaborate on " +
    "(use /playlists/{id}/items). Paste one of your own playlists, or use Excel upload for other catalogs."
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function retryAfterMs(res: Response, attempt: number): number {
  const raw = res.headers.get("retry-after");
  if (raw) {
    const asNum = Number(raw);
    if (Number.isFinite(asNum) && asNum >= 0) return Math.min(asNum * 1000, 60_000);
    const asDate = Date.parse(raw);
    if (Number.isFinite(asDate)) {
      return Math.min(Math.max(0, asDate - Date.now()), 60_000);
    }
  }
  return Math.min(1000 * 2 ** attempt, 30_000);
}

async function spotifyUserGet(accessToken: string, url: string, maxAttempts = 6): Promise<Response> {
  let last: Response | null = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (res.ok || (res.status !== 429 && res.status !== 502 && res.status !== 503)) {
      return res;
    }
    last = res;
    if (attempt === maxAttempts - 1) return res;
    const wait = retryAfterMs(res, attempt);
    console.warn(
      `Spotify ${res.status} on playlist fetch — retry ${attempt + 1}/${maxAttempts - 1} in ${Math.round(wait / 1000)}s`,
    );
    // Consume body so the connection can close cleanly
    await res.text().catch(() => undefined);
    await sleep(wait);
  }
  return last!;
}

export async function fetchPlaylistMeta(
  accessToken: string,
  playlistId: string,
): Promise<{ id: string; name: string; url: string }> {
  const res = await spotifyUserGet(
    accessToken,
    `https://api.spotify.com/v1/playlists/${playlistId}`,
  );
  if (!res.ok) {
    const body = await res.text();
    if (res.status === 403) throw new Error(forbiddenPlaylistMessage(res.status, body));
    throw new Error(`Playlist fetch failed: ${res.status} ${body}`);
  }
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
  // Don't pass market= — it can drop tracks unavailable in that market (e.g. US
  // filter on a UK playlist). User token already scopes availability.
  // Prefer offset pagination; `next` URLs are a fallback if present.
  const pageSize = 50;
  let offset = 0;
  let total = Number.POSITIVE_INFINITY;
  let pages = 0;

  while (offset < total) {
    const url =
      `https://api.spotify.com/v1/playlists/${playlistId}/items` +
      `?limit=${pageSize}&offset=${offset}&additional_types=track`;
    const res = await spotifyUserGet(accessToken, url);
    if (!res.ok) {
      throw new Error(forbiddenPlaylistMessage(res.status, await res.text()));
    }
    const data = (await res.json()) as PlaylistPaging & { limit?: number };
    const page = data.items ?? [];
    if (typeof data.total === "number" && Number.isFinite(data.total)) {
      total = data.total;
    }
    for (const item of page) {
      const t = playlistItemAsTrack(item);
      if (!t) continue;
      const year = t.album?.release_date?.slice(0, 4);
      rows.push({
        artist: (t.artists ?? []).map((a) => a.name).join("; "),
        title: t.name,
        year: year || undefined,
        spotify_id: t.id,
        isrc: t.external_ids?.isrc?.trim() || undefined,
      });
    }
    pages += 1;
    offset += pageSize;
    // Stop if Spotify returned a short page and no authoritative total
    if (page.length === 0) break;
    if (!Number.isFinite(total) && page.length < pageSize) break;
    // Safety: avoid runaway if total is wrong
    if (pages > 200) break;
  }

  console.info(
    `Playlist ${playlistId}: fetched ${rows.length} playable tracks` +
      (Number.isFinite(total) ? ` (Spotify total items=${total})` : ""),
  );

  if (rows.length === 0) {
    throw new Error(
      "Playlist has no playable tracks (or Spotify withheld items — only owned/collaborative playlists return contents).",
    );
  }
  return rows;
}

export type UserPlaylistSummary = {
  id: string;
  name: string;
  url: string;
  track_count: number;
};

/** Load the user's playlists (paginated). Default max 200 — not a daily quota. */
export async function fetchUserPlaylists(
  accessToken: string,
  limit = 200,
): Promise<UserPlaylistSummary[]> {
  const out: UserPlaylistSummary[] = [];
  const pageSize = 50;
  let url: string | null =
    `https://api.spotify.com/v1/me/playlists?limit=${pageSize}&offset=0`;

  while (url && out.length < limit) {
    const res = await spotifyUserGet(accessToken, url);
    if (!res.ok) throw new Error(`User playlists failed: ${await res.text()}`);
    const data = (await res.json()) as {
      items: Array<{
        id: string;
        name: string;
        external_urls: { spotify: string };
        tracks?: { total: number };
        items?: { total: number };
      }>;
      next: string | null;
    };
    for (const p of data.items) {
      out.push({
        id: p.id,
        name: p.name,
        url: p.external_urls.spotify,
        track_count: p.items?.total ?? p.tracks?.total ?? 0,
      });
      if (out.length >= limit) break;
    }
    url = out.length >= limit ? null : data.next;
  }
  return out;
}
