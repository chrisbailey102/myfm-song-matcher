import type { EnrichedSong } from "../types.js";
import { effectiveCamelot, effectiveTempo } from "../songEffective.js";
import { exec, newId, now, query, queryOne } from "./index.js";

export type DbSong = {
  id: string;
  project_id: string;
  position: number;
  artist: string;
  title: string;
  year: string | null;
  spotify_id_locked: string | null;
  spotify_id_resolved: string;
  spotify_url: string | null;
  spotify_name: string | null;
  spotify_artists: string | null;
  duration_ms: number;
  popularity: number;
  spotify_key: number;
  spotify_mode: number;
  tempo: number;
  tempo_override: number | null;
  camelot: string;
  camelot_override: string | null;
  time_signature: number;
  energy: number;
  danceability: number;
  match_confidence: number;
  needs_review: boolean;
  review_reason: string;
  bpm_key_source: string;
  lyrics_source: string;
  created_at: number;
  updated_at: number;
};

export function dbSongToEnriched(s: DbSong): EnrichedSong {
  return {
    artist: s.artist,
    title: s.title,
    year: s.year ?? undefined,
    spotify_id: s.spotify_id_locked ?? undefined,
    spotify_id_resolved: s.spotify_id_resolved,
    spotify_url: s.spotify_url ?? "",
    spotify_name: s.spotify_name ?? "",
    spotify_artists: s.spotify_artists ?? "",
    duration_ms: s.duration_ms,
    popularity: s.popularity,
    spotify_key: s.spotify_key,
    spotify_mode: s.spotify_mode,
    tempo: effectiveTempo(s),
    camelot: effectiveCamelot(s),
    time_signature: s.time_signature,
    energy: s.energy,
    danceability: s.danceability,
    match_confidence: s.match_confidence,
    needs_review: s.needs_review,
    review_reason: s.review_reason,
    bpm_key_source: s.bpm_key_source,
    lyrics_source: s.lyrics_source || undefined,
    tempo_override: s.tempo_override ?? undefined,
    camelot_override: s.camelot_override ?? undefined,
  };
}

export async function replaceProjectSongs(
  projectId: string,
  songs: EnrichedSong[],
): Promise<void> {
  await exec(`DELETE FROM songs WHERE project_id = $1`, [projectId]);
  const ts = now();
  for (let i = 0; i < songs.length; i++) {
    const s = songs[i];
    await exec(
      `INSERT INTO songs (
        id, project_id, position, artist, title, year, spotify_id_locked, spotify_id_resolved,
        spotify_url, spotify_name, spotify_artists, duration_ms, popularity, spotify_key, spotify_mode,
        tempo, camelot, time_signature, energy, danceability, match_confidence, needs_review,
        review_reason, bpm_key_source, lyrics_source, created_at, updated_at
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$26
      )`,
      [
        newId(),
        projectId,
        i,
        s.artist,
        s.title,
        s.year ?? null,
        s.spotify_id ?? null,
        s.spotify_id_resolved,
        s.spotify_url,
        s.spotify_name,
        s.spotify_artists,
        s.duration_ms,
        s.popularity,
        s.spotify_key,
        s.spotify_mode,
        s.tempo,
        s.camelot,
        s.time_signature,
        s.energy,
        s.danceability,
        s.match_confidence,
        s.needs_review,
        s.review_reason,
        s.bpm_key_source ?? "",
        s.lyrics_source ?? "",
        ts,
      ],
    );
  }
}

export async function listSongsForProject(projectId: string): Promise<DbSong[]> {
  return query<DbSong>(
    `SELECT * FROM songs WHERE project_id = $1 ORDER BY position ASC`,
    [projectId],
  );
}

export async function getSongById(id: string): Promise<DbSong | null> {
  return queryOne<DbSong>(`SELECT * FROM songs WHERE id = $1`, [id]);
}

export async function deleteSongFromProject(songId: string): Promise<boolean> {
  const song = await getSongById(songId);
  if (!song) return false;
  await exec(`DELETE FROM songs WHERE id = $1`, [songId]);
  return true;
}

/** Copy a song row into another project (skips if that Spotify id is already there). */
export async function copySongToProject(
  targetProjectId: string,
  source: DbSong | EnrichedSong,
): Promise<{ song: DbSong | null; created: boolean }> {
  const spotifyId =
    "spotify_id_resolved" in source
      ? source.spotify_id_resolved
      : (source as EnrichedSong).spotify_id_resolved;
  if (!spotifyId) return { song: null, created: false };

  const existing = await queryOne<DbSong>(
    `SELECT * FROM songs WHERE project_id = $1 AND spotify_id_resolved = $2`,
    [targetProjectId, spotifyId],
  );
  if (existing) return { song: existing, created: false };

  const posRow = await queryOne<{ n: number }>(
    `SELECT COALESCE(MAX(position), -1)::int + 1 AS n FROM songs WHERE project_id = $1`,
    [targetProjectId],
  );
  const position = posRow?.n ?? 0;
  const ts = now();
  const id = newId();

  const artist = source.artist;
  const title = source.title;
  const year = "year" in source ? source.year ?? null : null;
  const locked =
    "spotify_id_locked" in source ? source.spotify_id_locked ?? null : null;
  const spotify_url = source.spotify_url ?? null;
  const spotify_name =
    "spotify_name" in source ? source.spotify_name ?? title : title;
  const spotify_artists =
    "spotify_artists" in source ? source.spotify_artists ?? artist : artist;
  const duration_ms = "duration_ms" in source ? source.duration_ms ?? 0 : 0;
  const popularity = "popularity" in source ? source.popularity ?? 0 : 0;
  const spotify_key = "spotify_key" in source ? source.spotify_key ?? -1 : -1;
  const spotify_mode = "spotify_mode" in source ? source.spotify_mode ?? -1 : -1;
  const tempo =
    "tempo_override" in source && source.tempo_override != null
      ? Number(source.tempo_override) || Number(source.tempo) || 0
      : Number(source.tempo) || 0;
  const tempo_override =
    "tempo_override" in source ? source.tempo_override ?? null : null;
  const camelot =
    "camelot_override" in source && source.camelot_override
      ? String(source.camelot_override)
      : String(source.camelot || "");
  const camelot_override =
    "camelot_override" in source ? source.camelot_override ?? null : null;
  const time_signature =
    "time_signature" in source ? source.time_signature ?? 4 : 4;
  const energy = "energy" in source ? Number(source.energy) || 0 : 0;
  const danceability =
    "danceability" in source ? Number(source.danceability) || 0 : 0;
  const match_confidence =
    "match_confidence" in source ? Number(source.match_confidence) || 0 : 0;
  const needs_review =
    "needs_review" in source ? Boolean(source.needs_review) : false;
  const review_reason =
    "review_reason" in source ? String(source.review_reason || "") : "";
  const bpm_key_source =
    "bpm_key_source" in source ? String(source.bpm_key_source || "") : "";
  const lyrics_source =
    "lyrics_source" in source ? String(source.lyrics_source || "") : "";

  await exec(
    `INSERT INTO songs (
      id, project_id, position, artist, title, year, spotify_id_locked, spotify_id_resolved,
      spotify_url, spotify_name, spotify_artists, duration_ms, popularity, spotify_key, spotify_mode,
      tempo, tempo_override, camelot, camelot_override, time_signature, energy, danceability,
      match_confidence, needs_review, review_reason, bpm_key_source, lyrics_source, created_at, updated_at
    ) VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8,
      $9,$10,$11,$12,$13,$14,$15,
      $16,$17,$18,$19,$20,$21,$22,
      $23,$24,$25,$26,$27,$28,$28
    )`,
    [
      id,
      targetProjectId,
      position,
      artist,
      title,
      year,
      locked,
      spotifyId,
      spotify_url,
      spotify_name,
      spotify_artists,
      duration_ms,
      popularity,
      spotify_key,
      spotify_mode,
      tempo,
      tempo_override,
      camelot,
      camelot_override,
      time_signature,
      energy,
      danceability,
      match_confidence,
      needs_review,
      review_reason,
      bpm_key_source,
      lyrics_source,
      ts,
    ],
  );
  return { song: await getSongById(id), created: true };
}

export async function updateSongOverrides(
  id: string,
  input: { tempo_override?: number | null; camelot_override?: string | null },
): Promise<DbSong | null> {
  const song = await getSongById(id);
  if (!song) return null;
  const tempo_override =
    input.tempo_override !== undefined ? input.tempo_override : song.tempo_override;
  const camelot_override =
    input.camelot_override !== undefined ? input.camelot_override : song.camelot_override;
  await exec(
    `UPDATE songs SET tempo_override = $1, camelot_override = $2, updated_at = $3 WHERE id = $4`,
    [tempo_override, camelot_override, now(), id],
  );
  return getSongById(id);
}

export async function updateSongAudioMetaBySpotifyId(
  spotifyId: string,
  meta: {
    tempo: number;
    camelot: string;
    spotify_key: number;
    spotify_mode: number;
    time_signature: number;
    energy: number;
    danceability: number;
    bpm_key_source: string;
  },
): Promise<void> {
  await exec(
    `UPDATE songs SET
      tempo = CASE WHEN $1::real > 0 THEN $1::real ELSE tempo END,
      camelot = CASE WHEN $2 <> '' THEN $2 ELSE camelot END,
      spotify_key = CASE WHEN $3::int >= 0 THEN $3::int ELSE spotify_key END,
      spotify_mode = CASE WHEN $4::int >= 0 THEN $4::int ELSE spotify_mode END,
      time_signature = CASE WHEN $5::int > 0 THEN $5::int ELSE time_signature END,
      energy = CASE WHEN $6::real > 0 THEN $6::real ELSE energy END,
      danceability = CASE WHEN $7::real > 0 THEN $7::real ELSE danceability END,
      bpm_key_source = CASE WHEN $8 <> '' THEN $8 ELSE bpm_key_source END,
      needs_review = CASE
        WHEN (CASE WHEN $1::real > 0 THEN $1::real ELSE tempo END) > 0
         AND (CASE WHEN $2 <> '' THEN $2 ELSE camelot END) <> ''
        THEN false
        ELSE needs_review
      END,
      updated_at = $9
    WHERE spotify_id_resolved = $10`,
    [
      meta.tempo,
      meta.camelot,
      meta.spotify_key,
      meta.spotify_mode,
      meta.time_signature,
      meta.energy,
      meta.danceability,
      meta.bpm_key_source,
      now(),
      spotifyId,
    ],
  );
}
