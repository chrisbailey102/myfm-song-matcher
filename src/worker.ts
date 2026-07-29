import { enrichCatalog } from "./catalog.js";
import {
  createJob,
  failJob,
  completeJob,
  updateJobProgress,
  claimNextPendingJob,
} from "./db/jobs.js";
import { updateProjectStatus, getProjectById, updateProjectSpotifyMeta } from "./db/projects.js";
import {
  replaceProjectSongs,
  listSongsForProject,
  dbSongToEnriched,
} from "./db/songs.js";
import { getUserById } from "./db/users.js";
import { upsertLibraryFromEnriched, listLibraryTracks, libraryToEnriched } from "./db/library.js";
import {
  getLyricsCache,
  upsertLyricsCache,
  listLyricsForSpotifyIds,
  parseTimedJson,
} from "./db/lyricsCache.js";
import {
  generatePairCandidates,
  type PairFilters,
  type LyricBundle,
} from "./pairs.js";
import { enrichedForPairing } from "./songEffective.js";
import { ensureUserAccessToken } from "./spotifyAuth.js";
import { fetchPlaylistTracks, fetchPlaylistMeta } from "./spotifyPlaylist.js";
import { fetchBestLyrics } from "./lyrics.js";
import type { EnrichedSong } from "./types.js";

let running = false;

export function startJobWorker(): void {
  setInterval(() => {
    void processNextJob();
  }, 2000);
  void processNextJob();
}

async function processNextJob(): Promise<void> {
  if (running) return;
  const job = await claimNextPendingJob();
  if (!job) return;
  running = true;
  try {
    if (job.type === "enrich") {
      await runEnrichJob(job.id, job.project_id);
    } else if (job.type === "lyrics") {
      await runLyricsJob(job.id, job.project_id);
    } else if (job.type === "pairs") {
      await runPairsJob(job.id, job.project_id);
    } else {
      await failJob(job.id, `Unknown job type: ${job.type}`);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`Job ${job.id} failed:`, e);
    await failJob(job.id, msg);
    await updateProjectStatus(job.project_id, "failed");
  } finally {
    running = false;
  }
}

async function runEnrichJob(jobId: string, projectId: string): Promise<void> {
  const project = await getProjectById(projectId);
  if (!project) throw new Error("Project not found");
  const user = await getUserById(project.user_id);
  if (!user) throw new Error("User not found");
  if (!project.playlist_id) throw new Error("Project has no playlist");

  await updateProjectStatus(projectId, "importing");
  const token = await ensureUserAccessToken(user);

  await updateJobProgress(jobId, 0, 1, "Loading playlist tracks…");
  try {
    const meta = await fetchPlaylistMeta(token, project.playlist_id);
    await updateProjectSpotifyMeta(projectId, {
      playlist_name: meta.name,
      playlist_url: meta.url,
    });
  } catch (e) {
    console.warn("Could not refresh playlist meta:", e);
  }
  const rows = await fetchPlaylistTracks(token, project.playlist_id);

  await updateProjectStatus(projectId, "enriching");
  const enriched = await enrichCatalog(rows, (i, t, label) => {
    void updateJobProgress(jobId, i, t, label);
  });

  await replaceProjectSongs(projectId, enriched);
  await upsertLibraryFromEnriched(enriched);
  await completeJob(jobId);
  await createJob(projectId, "lyrics");
}

async function runLyricsJob(jobId: string, projectId: string): Promise<void> {
  const songs = await listSongsForProject(projectId);
  await updateProjectStatus(projectId, "lyrics");
  let i = 0;
  for (const song of songs) {
    i++;
    await updateJobProgress(
      jobId,
      i,
      songs.length,
      `${song.artist} — ${song.title}`,
    );
    const cached = await getLyricsCache(song.spotify_id_resolved);
    if (cached?.plain_text) {
      continue;
    }
    const got = await fetchBestLyrics(
      song.artist,
      song.title,
      song.duration_ms,
    );
    if (got) {
      await upsertLyricsCache({
        spotify_id: song.spotify_id_resolved,
        artist: song.artist,
        title: song.title,
        source: got.source,
        plain_text: got.text,
        timed_lines: got.timedLines,
      });
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  // refresh library lyrics_source flags
  const enriched = songs.map(dbSongToEnriched);
  for (const s of enriched) {
    const c = await getLyricsCache(s.spotify_id_resolved);
    if (c) s.lyrics_source = c.source;
  }
  await upsertLibraryFromEnriched(enriched);

  await completeJob(jobId);
  await updateProjectStatus(projectId, "ready");
  await createJob(projectId, "pairs");
}

async function runPairsJob(jobId: string, projectId: string): Promise<void> {
  await updateJobProgress(jobId, 1, 1, "Pairs computed on demand in the UI.");
  await completeJob(jobId);
}

async function loadLyricBundles(
  songs: EnrichedSong[],
): Promise<Map<string, LyricBundle>> {
  const ids = songs.map((s) => s.spotify_id_resolved);
  const rows = await listLyricsForSpotifyIds(ids);
  const map = new Map<string, LyricBundle>();
  for (const [id, row] of rows) {
    map.set(id, {
      text: row.plain_text,
      timed: parseTimedJson(row.timed_json),
    });
  }
  return map;
}

export type ProjectPairsQuery = {
  mode?: "playlist" | "expand";
  filters?: PairFilters;
};

/** Pairs for a project (uses overrides + cached lyrics). */
export async function getProjectPairs(
  projectId: string,
  query: ProjectPairsQuery = {},
) {
  const mode = query.mode ?? "playlist";
  const projectSongs = await listSongsForProject(projectId);
  const seeds = enrichedForPairing(projectSongs.map(dbSongToEnriched));

  let pool = seeds;
  let directed = false;
  if (mode === "expand") {
    const lib = await listLibraryTracks();
    const seedIds = new Set(seeds.map((s) => s.spotify_id_resolved));
    pool = enrichedForPairing(
      lib
        .filter((t) => !seedIds.has(t.spotify_id))
        .map(libraryToEnriched),
    );
    directed = true;
  }

  const allForLyrics = [...seeds, ...pool];
  const lyricsById = await loadLyricBundles(allForLyrics);
  const withLyrics = lyricsById.size > 0;

  return generatePairCandidates({
    seeds,
    pool,
    lyricsById,
    withLyrics,
    directed,
    filters: query.filters,
  });
}
