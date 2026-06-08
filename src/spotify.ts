import { requireEnv } from "./config.js";
import { SpotifyApiError } from "./spotifyErrors.js";

type SpotifyToken = { access_token: string; expires_at: number };

let cached: SpotifyToken | null = null;

async function getClientToken(): Promise<string> {
  const now = Date.now();
  if (cached && cached.expires_at > now + 5000) {
    return cached.access_token;
  }
  const id = requireEnv("SPOTIFY_CLIENT_ID");
  const secret = requireEnv("SPOTIFY_CLIENT_SECRET");
  const body = new URLSearchParams({ grant_type: "client_credentials" });
  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      Authorization:
        "Basic " + Buffer.from(`${id}:${secret}`).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Spotify token failed: ${res.status} ${t}`);
  }
  const json = (await res.json()) as {
    access_token: string;
    expires_in: number;
  };
  cached = {
    access_token: json.access_token,
    expires_at: now + json.expires_in * 1000,
  };
  return cached.access_token;
}

async function spotifyGet<T>(path: string): Promise<T> {
  const token = await getClientToken();
  const url = path.startsWith("http") ? path : `https://api.spotify.com/v1${path}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const t = await res.text();
    throw new SpotifyApiError(res.status, path, t);
  }
  return res.json() as Promise<T>;
}

export type SpotifyTrack = {
  id: string;
  name: string;
  duration_ms: number;
  popularity: number;
  external_urls: { spotify: string };
  artists: { name: string }[];
};

export type SpotifySearchResponse = {
  tracks?: { items: SpotifyTrack[] };
};

export type SpotifyAudioFeatures = {
  id: string;
  key: number;
  mode: number;
  tempo: number;
  time_signature: number;
  energy: number;
  danceability: number;
};

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/\s*\([^)]*remaster[^)]*\)/gi, "")
    .replace(/\s*\([^)]*mix[^)]*\)/gi, "")
    .replace(/\s*feat\.[^]+$/i, "")
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    Array(n + 1).fill(0),
  );
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost,
      );
    }
  }
  return dp[m][n];
}

function titleScore(queryTitle: string, trackName: string): number {
  const q = normalize(queryTitle);
  const t = normalize(trackName);
  if (!q.length || !t.length) return 0;
  if (t === q) return 1;
  if (t.includes(q) || q.includes(t)) return 0.92;
  const maxLen = Math.max(q.length, t.length);
  const dist = levenshtein(q, t);
  return Math.max(0, 1 - dist / maxLen);
}

function artistScore(queryArtist: string, trackArtists: string[]): number {
  const q = normalize(queryArtist);
  const joined = normalize(trackArtists.join(" "));
  if (!q.length) return 0;
  if (joined.includes(q)) return 1;
  for (const a of trackArtists) {
    if (normalize(a).includes(q) || q.includes(normalize(a))) return 0.95;
  }
  const best = Math.max(
    ...trackArtists.map((a) => {
      const na = normalize(a);
      const maxLen = Math.max(q.length, na.length) || 1;
      return 1 - levenshtein(q, na) / maxLen;
    }),
    0,
  );
  return best;
}

export type ScoredTrack = {
  track: SpotifyTrack;
  score: number;
  titleScore: number;
  artistScore: number;
};

export function scoreTrackMatch(
  artist: string,
  title: string,
  track: SpotifyTrack,
): ScoredTrack {
  const ts = titleScore(title, track.name);
  const as = artistScore(artist, track.artists.map((x) => x.name));
  const pop = (track.popularity ?? 0) / 100;
  const durationMin = track.duration_ms / 60_000;
  const shortBonus = durationMin < 3.8 ? 0.03 : durationMin > 6 ? -0.02 : 0;
  const score = 0.52 * ts + 0.38 * as + 0.1 * pop + shortBonus;
  return { track, score: Math.min(1, Math.max(0, score)), titleScore: ts, artistScore: as };
}

export async function searchTracks(
  artist: string,
  title: string,
  market = "US",
  limit = 8,
): Promise<SpotifyTrack[]> {
  const q = `track:${title} artist:${artist}`;
  const params = new URLSearchParams({
    q,
    type: "track",
    market,
    limit: String(limit),
  });
  const data = await spotifyGet<SpotifySearchResponse>(
    `/search?${params.toString()}`,
  );
  return data.tracks?.items ?? [];
}

export async function searchTracksRadioHint(
  artist: string,
  title: string,
  market = "US",
): Promise<SpotifyTrack[]> {
  const primary = await searchTracks(artist, title, market, 10);
  if (primary.length >= 3) return primary;
  const extra = await searchTracks(artist, `${title} radio`, market, 10);
  const byId = new Map<string, SpotifyTrack>();
  for (const t of [...primary, ...extra]) byId.set(t.id, t);
  return [...byId.values()];
}

export async function getTrackById(trackId: string): Promise<SpotifyTrack> {
  const params = new URLSearchParams({ market: "US" });
  return spotifyGet<SpotifyTrack>(
    `/tracks/${encodeURIComponent(trackId)}?${params.toString()}`,
  );
}

export async function getAudioFeatures(
  ids: string[],
): Promise<Map<string, SpotifyAudioFeatures>> {
  const out = new Map<string, SpotifyAudioFeatures>();
  const chunk = 100;
  for (let i = 0; i < ids.length; i += chunk) {
    const slice = ids.slice(i, i + chunk);
    const params = new URLSearchParams({ ids: slice.join(",") });
    const data = await spotifyGet<{ audio_features: (SpotifyAudioFeatures | null)[] }>(
      `/audio-features?${params.toString()}`,
    );
    for (const af of data.audio_features) {
      if (af?.id) out.set(af.id, af);
    }
  }
  return out;
}

export type ResolveResult = {
  chosen: SpotifyTrack;
  scored: ScoredTrack[];
  needs_review: boolean;
  review_reason: string;
  match_confidence: number;
};

export function resolveBestTrack(
  artist: string,
  title: string,
  candidates: SpotifyTrack[],
): ResolveResult {
  if (candidates.length === 0) {
    throw new Error(`No Spotify results for "${artist}" — "${title}"`);
  }
  const scored = candidates
    .map((t) => scoreTrackMatch(artist, title, t))
    .sort((a, b) => b.score - a.score);
  const top = scored[0];
  const second = scored[1];
  let needs_review = false;
  const reasons: string[] = [];
  if (top.titleScore < 0.75) {
    needs_review = true;
    reasons.push("weak_title_match");
  }
  if (top.artistScore < 0.7) {
    needs_review = true;
    reasons.push("weak_artist_match");
  }
  if (second && top.score - second.score < 0.06) {
    needs_review = true;
    reasons.push("ambiguous_top_two");
  }
  return {
    chosen: top.track,
    scored,
    needs_review,
    review_reason: reasons.join(";") || "ok",
    match_confidence: top.score,
  };
}
