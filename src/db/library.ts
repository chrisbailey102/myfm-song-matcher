import type { EnrichedSong } from "../types.js";
import { exec, now, query, queryOne } from "./index.js";

export type LibraryTrack = {
  spotify_id: string;
  artist: string;
  title: string;
  year: string | null;
  spotify_url: string | null;
  duration_ms: number;
  popularity: number;
  tempo: number;
  camelot: string;
  energy: number;
  danceability: number;
  bpm_key_source: string;
  lyrics_source: string;
  last_seen_at: number;
  created_at: number;
};

export async function upsertLibraryFromEnriched(
  songs: EnrichedSong[],
): Promise<void> {
  const ts = now();
  for (const s of songs) {
    await exec(
      `INSERT INTO library_tracks (
        spotify_id, artist, title, year, spotify_url, duration_ms, popularity,
        tempo, camelot, energy, danceability, bpm_key_source, lyrics_source,
        last_seen_at, created_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$14)
      ON CONFLICT (spotify_id) DO UPDATE SET
        artist = EXCLUDED.artist,
        title = EXCLUDED.title,
        year = COALESCE(EXCLUDED.year, library_tracks.year),
        spotify_url = EXCLUDED.spotify_url,
        duration_ms = EXCLUDED.duration_ms,
        popularity = EXCLUDED.popularity,
        tempo = CASE WHEN EXCLUDED.tempo > 0 THEN EXCLUDED.tempo ELSE library_tracks.tempo END,
        camelot = CASE WHEN EXCLUDED.camelot <> '' THEN EXCLUDED.camelot ELSE library_tracks.camelot END,
        energy = CASE WHEN EXCLUDED.energy > 0 THEN EXCLUDED.energy ELSE library_tracks.energy END,
        danceability = CASE WHEN EXCLUDED.danceability > 0 THEN EXCLUDED.danceability ELSE library_tracks.danceability END,
        bpm_key_source = CASE WHEN EXCLUDED.bpm_key_source <> '' THEN EXCLUDED.bpm_key_source ELSE library_tracks.bpm_key_source END,
        lyrics_source = CASE WHEN EXCLUDED.lyrics_source <> '' THEN EXCLUDED.lyrics_source ELSE library_tracks.lyrics_source END,
        last_seen_at = EXCLUDED.last_seen_at`,
      [
        s.spotify_id_resolved,
        s.artist,
        s.title,
        s.year ?? null,
        s.spotify_url || null,
        s.duration_ms,
        s.popularity,
        s.tempo,
        s.camelot,
        s.energy,
        s.danceability,
        s.bpm_key_source ?? "",
        s.lyrics_source ?? "",
        ts,
      ],
    );
  }
}

export async function listLibraryTracks(): Promise<LibraryTrack[]> {
  return query<LibraryTrack>(
    `SELECT * FROM library_tracks ORDER BY artist ASC, title ASC`,
  );
}

export async function getLibraryTrack(
  spotifyId: string,
): Promise<LibraryTrack | null> {
  return queryOne<LibraryTrack>(
    `SELECT * FROM library_tracks WHERE spotify_id = $1`,
    [spotifyId],
  );
}

export async function countLibraryTracks(): Promise<number> {
  const rows = await query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM library_tracks`,
  );
  return rows[0]?.n ?? 0;
}

export async function listLibraryTracksMissingMeta(): Promise<LibraryTrack[]> {
  return query<LibraryTrack>(
    `SELECT * FROM library_tracks
     WHERE tempo = 0 OR tempo IS NULL
        OR camelot = '' OR camelot IS NULL
        OR energy = 0 OR energy IS NULL
     ORDER BY artist ASC, title ASC`,
  );
}

export async function updateLibraryAudioMeta(
  spotifyId: string,
  meta: {
    tempo: number;
    camelot: string;
    energy: number;
    danceability: number;
    bpm_key_source: string;
  },
): Promise<void> {
  await exec(
    `UPDATE library_tracks SET
      tempo = CASE WHEN $1::real > 0 THEN $1::real ELSE tempo END,
      camelot = CASE WHEN $2 <> '' THEN $2 ELSE camelot END,
      energy = CASE WHEN $3::real > 0 THEN $3::real ELSE energy END,
      danceability = CASE WHEN $4::real > 0 THEN $4::real ELSE danceability END,
      bpm_key_source = CASE WHEN $5 <> '' THEN $5 ELSE bpm_key_source END,
      last_seen_at = $6
    WHERE spotify_id = $7`,
    [
      meta.tempo,
      meta.camelot,
      meta.energy,
      meta.danceability,
      meta.bpm_key_source,
      now(),
      spotifyId,
    ],
  );
}

export function libraryToEnriched(t: LibraryTrack): EnrichedSong {
  return {
    artist: t.artist,
    title: t.title,
    year: t.year ?? undefined,
    spotify_id_resolved: t.spotify_id,
    spotify_url: t.spotify_url ?? "",
    spotify_name: t.title,
    spotify_artists: t.artist,
    duration_ms: t.duration_ms,
    popularity: t.popularity,
    spotify_key: -1,
    spotify_mode: -1,
    tempo: t.tempo,
    camelot: t.camelot,
    time_signature: 4,
    energy: t.energy,
    danceability: t.danceability,
    match_confidence: 1,
    needs_review: false,
    review_reason: "library",
    bpm_key_source: t.bpm_key_source,
    lyrics_source: t.lyrics_source,
  };
}
