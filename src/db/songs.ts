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
        review_reason, bpm_key_source, created_at, updated_at
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$25
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
