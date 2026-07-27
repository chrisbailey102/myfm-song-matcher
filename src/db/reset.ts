import { exec, queryOne } from "./index.js";

export type CatalogResetCounts = {
  projects: number;
  songs: number;
  jobs: number;
  libraryTracks: number;
  lyricsCache: number;
};

/** Wipe playlists, songs, library, lyrics cache, and jobs. Keeps Spotify users/sessions. */
export async function resetCatalogData(): Promise<CatalogResetCounts> {
  const row = await queryOne<{
    projects: number;
    songs: number;
    jobs: number;
    library_tracks: number;
    lyrics_cache: number;
  }>(`
    SELECT
      (SELECT COUNT(*)::int FROM projects) AS projects,
      (SELECT COUNT(*)::int FROM songs) AS songs,
      (SELECT COUNT(*)::int FROM jobs) AS jobs,
      (SELECT COUNT(*)::int FROM library_tracks) AS library_tracks,
      (SELECT COUNT(*)::int FROM lyrics_cache) AS lyrics_cache
  `);

  await exec(`
    TRUNCATE TABLE songs, jobs, projects, library_tracks, lyrics_cache
  `);

  return {
    projects: row?.projects ?? 0,
    songs: row?.songs ?? 0,
    jobs: row?.jobs ?? 0,
    libraryTracks: row?.library_tracks ?? 0,
    lyricsCache: row?.lyrics_cache ?? 0,
  };
}
