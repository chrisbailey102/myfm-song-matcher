import { enrichCatalog } from "./catalog.js";
import { createJob, failJob, completeJob, updateJobProgress, claimNextPendingJob } from "./db/jobs.js";
import { updateProjectStatus } from "./db/projects.js";
import { replaceProjectSongs, listSongsForProject, dbSongToEnriched } from "./db/songs.js";
import { getUserById } from "./db/users.js";
import { generatePairCandidates } from "./pairs.js";
import { enrichedForPairing } from "./songEffective.js";
import { ensureUserAccessToken } from "./spotifyAuth.js";
import { fetchPlaylistTracks } from "./spotifyPlaylist.js";
import { getProjectById } from "./db/projects.js";

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
  const playlistId = project.playlist_id;

  await updateJobProgress(jobId, 0, 1, "Loading playlist tracks…");
  const rows = await fetchPlaylistTracks(token, playlistId);

  await updateProjectStatus(projectId, "enriching");
  const enriched = await enrichCatalog(rows, (i, t, label) => {
    void updateJobProgress(jobId, i, t, label);
  });

  await replaceProjectSongs(projectId, enriched);
  await completeJob(jobId);
  await updateProjectStatus(projectId, "ready");

  await createJob(projectId, "pairs");
}

async function runPairsJob(jobId: string, projectId: string): Promise<void> {
  await updateJobProgress(jobId, 1, 1, "Pair scoring is computed on demand in the UI.");
  await completeJob(jobId);
}

/** Pairs for a project (uses overrides). */
export async function getProjectPairs(projectId: string) {
  const songs = await listSongsForProject(projectId);
  const enriched = enrichedForPairing(songs.map(dbSongToEnriched));
  return generatePairCandidates({ songs: enriched, withLyrics: false });
}
