import crypto from "node:crypto";
import type { CatalogRow } from "./types.js";
import type { SpotifyTrack } from "./spotify.js";
import { getTracksByIds } from "./spotify.js";
import { resolveTrackAudioMeta } from "./audioMeta.js";
import {
  listLibraryTracksMissingMeta,
  updateLibraryAudioMeta,
} from "./db/library.js";
import { updateSongAudioMetaBySpotifyId, listSongsForProject } from "./db/songs.js";

export type MetaBackfillJob = {
  id: string;
  status: "running" | "done" | "failed";
  progress: number;
  progress_total: number;
  progress_label: string;
  filled: number;
  still_missing: number;
  error?: string;
  created_at: number;
  scope: "library" | "project";
  project_id?: string;
};

const jobs = new Map<string, MetaBackfillJob>();

export function getMetaBackfillJob(id: string): MetaBackfillJob | null {
  return jobs.get(id) ?? null;
}

function pruneOldJobs(): void {
  const cutoff = Date.now() - 2 * 3600_000;
  for (const [k, v] of jobs) {
    if (v.created_at < cutoff) jobs.delete(k);
  }
}

type MissingRow = {
  spotify_id: string;
  artist: string;
  title: string;
};

function isMissingMeta(s: {
  tempo: number | null;
  camelot: string | null;
  energy: number | null;
}): boolean {
  return !s.tempo || !String(s.camelot || "").trim() || !s.energy;
}

export function startLibraryMetaBackfill(): MetaBackfillJob {
  const id = crypto.randomUUID();
  const job: MetaBackfillJob = {
    id,
    status: "running",
    progress: 0,
    progress_total: 0,
    progress_label: "Finding tracks missing BPM/key/energy…",
    filled: 0,
    still_missing: 0,
    created_at: Date.now(),
    scope: "library",
  };
  jobs.set(id, job);
  pruneOldJobs();
  void runBackfill(job, async () => {
    const tracks = await listLibraryTracksMissingMeta();
    return tracks.map((t) => ({
      spotify_id: t.spotify_id,
      artist: t.artist,
      title: t.title,
    }));
  });
  return job;
}

export function startProjectMetaBackfill(projectId: string): MetaBackfillJob {
  const id = crypto.randomUUID();
  const job: MetaBackfillJob = {
    id,
    status: "running",
    progress: 0,
    progress_total: 0,
    progress_label: "Finding tracks missing BPM/key/energy…",
    filled: 0,
    still_missing: 0,
    created_at: Date.now(),
    scope: "project",
    project_id: projectId,
  };
  jobs.set(id, job);
  pruneOldJobs();
  void runBackfill(job, async () => {
    const songs = await listSongsForProject(projectId);
    return songs
      .filter((s) =>
        isMissingMeta({
          tempo: s.tempo,
          camelot: s.camelot,
          energy: s.energy,
        }),
      )
      .map((s) => ({
        spotify_id: s.spotify_id_resolved,
        artist: s.artist,
        title: s.title,
      }));
  });
  return job;
}

async function runBackfill(
  job: MetaBackfillJob,
  loadMissing: () => Promise<MissingRow[]>,
): Promise<void> {
  try {
    const missing = await loadMissing();
    job.progress_total = missing.length;
    if (missing.length === 0) {
      job.status = "done";
      job.progress_label = "Nothing missing — all tracks have BPM/key/energy.";
      return;
    }

    job.progress_label = `Resolving Spotify metadata for ${missing.length} tracks…`;
    const resolved: Array<{ row: CatalogRow; track: SpotifyTrack }> = [];
    let byId = new Map<string, SpotifyTrack>();
    try {
      byId = await getTracksByIds(missing.map((m) => m.spotify_id));
    } catch (e) {
      console.warn("Batch Spotify track fetch failed during backfill:", e);
    }
    for (let i = 0; i < missing.length; i++) {
      const m = missing[i];
      job.progress = i;
      job.progress_label = `Loading ${m.artist} — ${m.title}`;
      const track =
        byId.get(m.spotify_id) ??
        ({
          id: m.spotify_id,
          name: m.title,
          duration_ms: 0,
          popularity: 0,
          external_urls: { spotify: "" },
          artists: [{ name: m.artist }],
        } satisfies SpotifyTrack);
      resolved.push({
        row: {
          artist: m.artist,
          title: m.title,
          spotify_id: m.spotify_id,
          isrc: track.external_ids?.isrc,
        },
        track,
      });
    }

    const audioMeta = await resolveTrackAudioMeta(resolved, (msg) => {
      job.progress_label = msg;
    });

    let filled = 0;
    for (const { track } of resolved) {
      const meta = audioMeta.get(track.id);
      if (!meta) continue;
      // Persist when we got BPM and/or energy (energy-only fills for existing BPM rows).
      if (!meta.tempo && !(meta.energy > 0)) continue;
      await updateLibraryAudioMeta(track.id, meta);
      await updateSongAudioMetaBySpotifyId(track.id, meta);
      filled++;
    }

    job.filled = filled;
    job.still_missing = missing.length - filled;
    job.progress = missing.length;
    job.status = "done";
    job.progress_label =
      job.still_missing > 0
        ? `Filled ${filled}/${missing.length} — ${job.still_missing} still missing.`
        : `Filled ${filled}/${missing.length} tracks.`;
  } catch (e) {
    job.status = "failed";
    job.error = e instanceof Error ? e.message : String(e);
    job.progress_label = "Failed";
  }
}
