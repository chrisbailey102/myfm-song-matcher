import crypto from "node:crypto";
import type { Express, Request, Response } from "express";
import multer from "multer";
import fs from "node:fs";
import path from "node:path";
import { parse } from "csv-parse/sync";
import { assertSpotifyConfigured, PROJECT_ROOT } from "./config.js";
import { getEnrichJob, startEnrichJob } from "./enrichJobs.js";
import {
  getMetaBackfillJob,
  startLibraryMetaBackfill,
  startProjectMetaBackfill,
} from "./metaBackfill.js";
import { createJob, getJobById, listJobsForProject, hasActiveJob } from "./db/jobs.js";
import { listSongsForProject, updateSongOverrides, getSongById, copySongToProject, deleteSongFromProject } from "./db/songs.js";
import {
  createProject,
  deleteProject,
  getProjectById,
  listProjectsWithCounts,
  updateProjectName,
  touchProject,
  moveRootItem,
  moveProjectInFolder,
  setProjectFolder,
  nextRootSortOrder,
} from "./db/projects.js";
import {
  createFolder,
  getFolderById,
  listFoldersWithCounts,
  updateFolderName,
  deleteFolder,
} from "./db/folders.js";
import {
  buildSpotifyAuthorizeUrl,
  clearSession,
  getAppBaseUrl,
  getSessionUser,
  loginWithSpotifyCode,
  requireAuth,
  setSessionUser,
  ensureUserAccessToken,
} from "./spotifyAuth.js";
import {
  fetchPlaylistMeta,
  fetchUserPlaylists,
  parsePlaylistId,
} from "./spotifyPlaylist.js";
import {
  fetchTrackPreviewUrl,
  pauseSpotifyPlayback,
  spotifyOpenUrl,
  startSpotifyPlayback,
} from "./spotifyPlayback.js";
import { searchProjectLyrics } from "./db/lyricsCache.js";
import { resetCatalogData } from "./db/reset.js";
import { getProjectPairs } from "./worker.js";
import type { DbUser } from "./db/users.js";

const oauthStates = new Map<string, number>();

function cleanupOauthStates(): void {
  const cutoff = Date.now() - 600_000;
  for (const [k, v] of oauthStates) {
    if (v < cutoff) oauthStates.delete(k);
  }
}

function authed(req: Request): DbUser {
  return (req as Request & { user: DbUser }).user;
}

export function registerRoutes(app: Express): void {
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 25 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
      if (!/\.xlsx$/i.test(file.originalname)) {
        cb(new Error("Please upload a .xlsx file."));
        return;
      }
      cb(null, true);
    },
  });

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.get("/api/auth/me", async (req, res) => {
    const user = await getSessionUser(req);
    if (!user) {
      res.json({ loggedIn: false });
      return;
    }
    res.json({
      loggedIn: true,
      displayName: user.display_name,
      spotifyId: user.spotify_id,
    });
  });

  app.get("/auth/spotify", (_req, res) => {
    try {
      assertSpotifyConfigured();
      cleanupOauthStates();
      const state = crypto.randomBytes(16).toString("hex");
      oauthStates.set(state, Date.now());
      res.redirect(buildSpotifyAuthorizeUrl(state));
    } catch (e) {
      res.status(500).send(e instanceof Error ? e.message : String(e));
    }
  });

  app.get("/auth/spotify/callback", async (req, res) => {
    try {
      const code = String(req.query.code ?? "");
      const state = String(req.query.state ?? "");
      const err = req.query.error;
      if (err) {
        res.redirect(`/?auth_error=${encodeURIComponent(String(err))}`);
        return;
      }
      if (!code || !oauthStates.has(state)) {
        res.status(400).send("Invalid OAuth state. Try connecting again.");
        return;
      }
      oauthStates.delete(state);
      const user = await loginWithSpotifyCode(code);
      setSessionUser(res, user.id);
      res.redirect("/?connected=1");
    } catch (e) {
      console.error(e);
      res.redirect(`/?auth_error=${encodeURIComponent(e instanceof Error ? e.message : String(e))}`);
    }
  });

  app.post("/api/auth/logout", (_req, res) => {
    clearSession(res);
    res.json({ ok: true });
  });

  app.get("/api/spotify/playlists", requireAuth, async (req, res) => {
    try {
      const token = await ensureUserAccessToken(authed(req));
      const playlists = await fetchUserPlaylists(token, 40);
      res.json({ playlists });
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  /** Access token for Spotify Web Playback SDK (browser player). */
  app.get("/api/spotify/token", requireAuth, async (req, res) => {
    try {
      const user = authed(req);
      const access_token = await ensureUserAccessToken(user);
      res.json({
        access_token,
        expires_at: user.token_expires_at,
      });
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  /** Play on Song Matcher web player device_id, else active Spotify device (Premium). */
  app.post("/api/spotify/play", requireAuth, async (req, res) => {
    try {
      const { spotifyId, positionMs, deviceId } = req.body as {
        spotifyId?: string;
        positionMs?: number;
        deviceId?: string;
      };
      if (!spotifyId?.trim()) {
        res.status(400).json({ error: "spotifyId required" });
        return;
      }
      const token = await ensureUserAccessToken(authed(req));
      const ms = Number(positionMs) || 0;
      const device = deviceId?.trim() || undefined;
      try {
        await startSpotifyPlayback(token, spotifyId.trim(), ms, device);
        res.json({
          ok: true,
          mode: device ? "web" : "device",
          openUrl: spotifyOpenUrl(spotifyId.trim(), ms),
        });
      } catch (playErr) {
        const preview = await fetchTrackPreviewUrl(token, spotifyId.trim());
        const msg = playErr instanceof Error ? playErr.message : String(playErr);
        const needsReauth =
          playErr instanceof Error &&
          ((playErr as Error & { code?: string }).code === "needs_reauth" ||
            /permissions missing|401/i.test(msg));
        res.status(200).json({
          ok: false,
          mode: preview ? "preview" : "open",
          previewUrl: preview,
          openUrl: spotifyOpenUrl(spotifyId.trim(), ms),
          needsReauth,
          error: msg,
        });
      }
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  app.post("/api/spotify/pause", requireAuth, async (req, res) => {
    try {
      const token = await ensureUserAccessToken(authed(req));
      await pauseSpotifyPlayback(token);
      res.json({ ok: true });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const needsReauth =
        e instanceof Error &&
        ((e as Error & { code?: string }).code === "needs_reauth" ||
          /permissions missing|401/i.test(msg));
      res.status(400).json({ error: msg, needsReauth });
    }
  });

  app.get("/api/spotify/preview/:spotifyId", requireAuth, async (req, res) => {
    try {
      const token = await ensureUserAccessToken(authed(req));
      const previewUrl = await fetchTrackPreviewUrl(token, req.params.spotifyId);
      res.json({
        previewUrl,
        openUrl: spotifyOpenUrl(req.params.spotifyId, 0),
      });
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  app.get("/api/projects", requireAuth, async (req, res) => {
    const userId = authed(req).id;
    const [projects, folders] = await Promise.all([
      listProjectsWithCounts(userId),
      listFoldersWithCounts(userId),
    ]);
    res.json({ projects, folders });
  });

  app.post("/api/folders", requireAuth, async (req, res) => {
    try {
      const user = authed(req);
      const name = String((req.body as { name?: string })?.name || "").trim();
      if (!name) {
        res.status(400).json({ error: "Name required" });
        return;
      }
      const sort_order = await nextRootSortOrder(user.id);
      const folder = await createFolder(user.id, name, sort_order);
      res.json({ folder });
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  app.patch("/api/folders/:id", requireAuth, async (req, res) => {
    try {
      const folder = await getFolderById(req.params.id);
      if (!folder || folder.user_id !== authed(req).id) {
        res.status(404).json({ error: "Folder not found" });
        return;
      }
      const { name } = req.body as { name?: string };
      if (!name?.trim()) {
        res.status(400).json({ error: "Name required" });
        return;
      }
      const updated = await updateFolderName(folder.id, name);
      res.json({ folder: updated });
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  app.delete("/api/folders/:id", requireAuth, async (req, res) => {
    try {
      const folder = await getFolderById(req.params.id);
      if (!folder || folder.user_id !== authed(req).id) {
        res.status(404).json({ error: "Folder not found" });
        return;
      }
      await deleteFolder(folder.id);
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  app.post("/api/folders/:id/move", requireAuth, async (req, res) => {
    try {
      const folder = await getFolderById(req.params.id);
      if (!folder || folder.user_id !== authed(req).id) {
        res.status(404).json({ error: "Folder not found" });
        return;
      }
      const direction = (req.body as { direction?: string })?.direction;
      const dir = direction === "up" ? -1 : direction === "down" ? 1 : 0;
      if (!dir) {
        res.status(400).json({ error: 'direction must be "up" or "down"' });
        return;
      }
      const moved = await moveRootItem(authed(req).id, "folder", folder.id, dir);
      res.json({ ok: true, moved });
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  app.post("/api/projects/:id/move", requireAuth, async (req, res) => {
    try {
      const project = await getProjectById(req.params.id);
      if (!project || project.user_id !== authed(req).id) {
        res.status(404).json({ error: "Playlist not found" });
        return;
      }
      const body = req.body as {
        direction?: string;
        folderId?: string | null;
      };
      if (body.folderId !== undefined) {
        const folderId = body.folderId;
        if (folderId) {
          const folder = await getFolderById(folderId);
          if (!folder || folder.user_id !== authed(req).id) {
            res.status(404).json({ error: "Folder not found" });
            return;
          }
        }
        const updated = await setProjectFolder(
          project.id,
          folderId || null,
          authed(req).id,
        );
        res.json({ ok: true, project: updated });
        return;
      }
      const direction = body.direction;
      const dir = direction === "up" ? -1 : direction === "down" ? 1 : 0;
      if (!dir) {
        res.status(400).json({ error: 'direction must be "up" or "down", or pass folderId' });
        return;
      }
      const moved = project.folder_id
        ? await moveProjectInFolder(authed(req).id, project.id, dir)
        : await moveRootItem(authed(req).id, "project", project.id, dir);
      res.json({ ok: true, moved });
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  /** Re-fetch tracks from Spotify and re-enrich (Spotify-linked playlists only). */
  app.post("/api/projects/:id/refresh", requireAuth, async (req, res) => {
    try {
      const project = await getProjectById(req.params.id);
      if (!project || project.user_id !== authed(req).id) {
        res.status(404).json({ error: "Playlist not found" });
        return;
      }
      if (!project.playlist_id) {
        res.status(400).json({
          error: "This playlist isn’t linked to Spotify (custom playlist). Add tracks by dragging.",
        });
        return;
      }
      if (await hasActiveJob(project.id)) {
        res.status(409).json({ error: "An update is already running for this playlist." });
        return;
      }
      const job = await createJob(project.id, "enrich");
      res.json({ ok: true, project, job });
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  app.patch("/api/projects/:id", requireAuth, async (req, res) => {
    try {
      const project = await getProjectById(req.params.id);
      if (!project || project.user_id !== authed(req).id) {
        res.status(404).json({ error: "Playlist not found" });
        return;
      }
      const { name } = req.body as { name?: string };
      if (!name?.trim()) {
        res.status(400).json({ error: "Name required" });
        return;
      }
      const updated = await updateProjectName(project.id, name);
      res.json({ project: updated });
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  app.delete("/api/projects/:id", requireAuth, async (req, res) => {
    try {
      const project = await getProjectById(req.params.id);
      if (!project || project.user_id !== authed(req).id) {
        res.status(404).json({ error: "Playlist not found" });
        return;
      }
      await deleteProject(project.id);
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  /** Create an empty custom playlist (no Spotify import). */
  app.post("/api/projects/custom", requireAuth, async (req, res) => {
    try {
      const user = authed(req);
      const name = String((req.body as { name?: string })?.name || "").trim();
      if (!name) {
        res.status(400).json({ error: "Name required" });
        return;
      }
      const project = await createProject({
        user_id: user.id,
        name,
        status: "ready",
        playlist_name: name,
      });
      res.json({ project });
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  /** Copy a track into a playlist (from another playlist song id, or library spotify id). */
  app.post("/api/projects/:id/songs", requireAuth, async (req, res) => {
    try {
      const target = await getProjectById(req.params.id);
      if (!target || target.user_id !== authed(req).id) {
        res.status(404).json({ error: "Playlist not found" });
        return;
      }
      const { songId, spotifyId } = req.body as {
        songId?: string;
        spotifyId?: string;
      };

      let source: Awaited<ReturnType<typeof getSongById>> | null = null;
      if (songId && !songId.startsWith("lib:")) {
        source = await getSongById(songId);
        if (!source) {
          res.status(404).json({ error: "Source song not found" });
          return;
        }
        const srcProject = await getProjectById(source.project_id);
        if (!srcProject || srcProject.user_id !== authed(req).id) {
          res.status(403).json({ error: "Not allowed" });
          return;
        }
      } else {
        const sid = (spotifyId || songId?.replace(/^lib:/, "") || "").trim();
        if (!sid) {
          res.status(400).json({ error: "songId or spotifyId required" });
          return;
        }
        const { getLibraryTrack } = await import("./db/library.js");
        const lib = await getLibraryTrack(sid);
        if (!lib) {
          res.status(404).json({ error: "Library track not found" });
          return;
        }
        const { libraryToEnriched } = await import("./db/library.js");
        const enriched = libraryToEnriched(lib);
        const result = await copySongToProject(target.id, enriched);
        await touchProject(target.id);
        res.json({ ok: true, created: result.created, song: result.song });
        return;
      }

      const result = await copySongToProject(target.id, source);
      await touchProject(target.id);
      res.json({ ok: true, created: result.created, song: result.song });
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  app.delete("/api/songs/:id", requireAuth, async (req, res) => {
    try {
      const song = await getSongById(req.params.id);
      if (!song) {
        res.status(404).json({ error: "Song not found" });
        return;
      }
      const project = await getProjectById(song.project_id);
      if (!project || project.user_id !== authed(req).id) {
        res.status(403).json({ error: "Not allowed" });
        return;
      }
      await deleteSongFromProject(song.id);
      await touchProject(project.id);
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  /** Wipe all playlists, library tracks, lyrics cache, and jobs (keeps Spotify login). */
  app.post("/api/settings/reset-data", requireAuth, async (req, res) => {
    try {
      const confirm = String((req.body as { confirm?: string })?.confirm || "");
      if (confirm !== "DELETE ALL") {
        res.status(400).json({
          error: 'Confirmation required: send { "confirm": "DELETE ALL" }',
        });
        return;
      }
      const deleted = await resetCatalogData();
      res.json({ ok: true, deleted });
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  app.post("/api/projects", requireAuth, async (req, res) => {
    try {
      const user = authed(req);
      const { name, playlistUrl, playlistId, brief } = req.body as {
        name?: string;
        playlistUrl?: string;
        playlistId?: string;
        brief?: string;
      };
      const pid = playlistId?.trim() || parsePlaylistId(playlistUrl ?? "");
      const token = await ensureUserAccessToken(user);
      const meta = await fetchPlaylistMeta(token, pid);
      const project = await createProject({
        user_id: user.id,
        name: name?.trim() || meta.name,
        brief: brief?.trim() ?? "",
        playlist_id: meta.id,
        playlist_name: meta.name,
        playlist_url: meta.url,
      });
      const job = await createJob(project.id, "enrich");
      res.json({ project, job });
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  app.get("/api/projects/:id", requireAuth, async (req, res) => {
    const project = await getProjectById(req.params.id);
    if (!project || project.user_id !== authed(req).id) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    const songs = await listSongsForProject(project.id);
    const jobs = await listJobsForProject(project.id);
    res.json({ project, songs, jobs });
  });

  app.patch("/api/songs/:id", requireAuth, async (req, res) => {
    try {
      const { tempo_override, camelot_override } = req.body as {
        tempo_override?: number | null;
        camelot_override?: string | null;
      };
      const updated = await updateSongOverrides(req.params.id, {
        tempo_override,
        camelot_override:
          camelot_override === null || camelot_override === undefined
            ? camelot_override
            : String(camelot_override).trim().toUpperCase() || null,
      });
      if (!updated) {
        res.status(404).json({ error: "Song not found" });
        return;
      }
      res.json({ song: updated });
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  app.get("/api/projects/:id/pairs", requireAuth, async (req, res) => {
    try {
      const project = await getProjectById(req.params.id);
      if (!project || project.user_id !== authed(req).id) {
        res.status(404).json({ error: "Project not found" });
        return;
      }
      const mode =
        req.query.mode === "expand" ? ("expand" as const) : ("playlist" as const);
      const num = (v: unknown) => {
        if (v == null || v === "") return undefined;
        const n = Number(v);
        return Number.isFinite(n) ? n : undefined;
      };
      const filters = {
        bpmTolerance: num(req.query.bpmTolerance),
        minLyricScore: num(req.query.minLyricScore),
        minHarmonicScore: num(req.query.minHarmonicScore),
        requireBridge: req.query.requireBridge === "1" || req.query.requireBridge === "true",
        camelot: typeof req.query.camelot === "string" ? req.query.camelot : undefined,
        yearMin: num(req.query.yearMin),
        yearMax: num(req.query.yearMax),
        maxResults: num(req.query.maxResults) ?? 300,
      };
      const pairs = await getProjectPairs(project.id, { mode, filters });
      res.json({ pairs, count: pairs.length, mode, filters });
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  app.get("/api/projects/:id/lyrics/search", requireAuth, async (req, res) => {
    try {
      const project = await getProjectById(req.params.id);
      if (!project || project.user_id !== authed(req).id) {
        res.status(404).json({ error: "Project not found" });
        return;
      }
      const q = typeof req.query.q === "string" ? req.query.q : "";
      const hits = await searchProjectLyrics(project.id, q);
      res.json({ hits, count: hits.length, q });
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  app.get("/api/library", requireAuth, async (_req, res) => {
    try {
      const { listLibraryTracks, countLibraryTracks } = await import("./db/library.js");
      const tracks = await listLibraryTracks();
      const count = await countLibraryTracks();
      const songs = tracks.map((t) => ({
        id: `lib:${t.spotify_id}`,
        artist: t.artist,
        title: t.title,
        tempo: t.tempo,
        tempo_override: null,
        camelot: t.camelot,
        camelot_override: null,
        energy: t.energy,
        spotify_id_resolved: t.spotify_id,
        spotify_url: t.spotify_url,
        needs_review: false,
        bpm_key_source: t.bpm_key_source,
        year: t.year,
      }));
      res.json({ tracks, songs, count });
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  app.post("/api/library/backfill-meta", requireAuth, async (_req, res) => {
    const job = startLibraryMetaBackfill();
    res.json({ job });
  });

  app.post("/api/projects/:id/backfill-meta", requireAuth, async (req, res) => {
    const project = await getProjectById(req.params.id);
    if (!project || project.user_id !== authed(req).id) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    const job = startProjectMetaBackfill(project.id);
    res.json({ job });
  });

  app.get("/api/backfill-meta/:jobId", requireAuth, (req, res) => {
    const job = getMetaBackfillJob(req.params.jobId);
    if (!job) {
      res.status(404).json({ error: "Job not found" });
      return;
    }
    res.json({ job });
  });

  app.get("/api/library/lyrics/search", requireAuth, async (req, res) => {
    try {
      const q = typeof req.query.q === "string" ? req.query.q : "";
      const needle = q.trim();
      if (needle.length < 2) {
        res.json({ hits: [], count: 0, q });
        return;
      }
      const { query } = await import("./db/index.js");
      const { parseTimedJson } = await import("./db/lyricsCache.js");
      const rows = await query<{
        spotify_id: string;
        artist: string;
        title: string;
        source: string;
        plain_text: string;
        timed_json: string | null;
      }>(
        `SELECT l.spotify_id, t.artist, t.title, l.source, l.plain_text, l.timed_json
         FROM lyrics_cache l
         INNER JOIN library_tracks t ON t.spotify_id = l.spotify_id
         WHERE l.plain_text ILIKE '%' || $1 || '%'
         ORDER BY t.artist, t.title
         LIMIT 40`,
        [needle],
      );
      const lower = needle.toLowerCase();
      const hits = rows.map((r) => {
        const text = r.plain_text;
        const idx = text.toLowerCase().indexOf(lower);
        const start = Math.max(0, idx - 40);
        const end = Math.min(text.length, idx + needle.length + 60);
        let snippet = text.slice(start, end).replace(/\s+/g, " ").trim();
        if (start > 0) snippet = "…" + snippet;
        if (end < text.length) snippet = snippet + "…";
        let match_ms: number | null = null;
        for (const line of parseTimedJson(r.timed_json)) {
          if (line.text.toLowerCase().includes(lower)) {
            match_ms = line.startMs;
            break;
          }
        }
        return {
          spotify_id: r.spotify_id,
          artist: r.artist,
          title: r.title,
          source: r.source,
          snippet,
          match_ms,
        };
      });
      res.json({ hits, count: hits.length, q });
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  app.get("/api/jobs/:id", requireAuth, async (req, res) => {
    const job = await getJobById(req.params.id);
    if (!job) {
      res.status(404).json({ error: "Job not found" });
      return;
    }
    const project = await getProjectById(job.project_id);
    if (!project || project.user_id !== authed(req).id) {
      res.status(404).json({ error: "Job not found" });
      return;
    }
    res.json({ job });
  });

  /** Legacy Excel enrich (no login) — async job with progress polling */
  app.post("/api/enrich", upload.single("file"), async (req, res) => {
    try {
      assertSpotifyConfigured();
      if (!req.file?.buffer?.length) {
        res.status(400).json({ error: "No file received. Choose a .xlsx and try again." });
        return;
      }
      const job = startEnrichJob(req.file.buffer);
      res.json({ jobId: job.id, job });
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  app.get("/api/enrich/:jobId", (req, res) => {
    const job = getEnrichJob(req.params.jobId);
    if (!job) {
      res.status(404).json({ error: "Enrich job not found (server may have restarted)." });
      return;
    }
    res.json({ job });
  });

  app.get("/api/enrich/:jobId/csv", (req, res) => {
    const job = getEnrichJob(req.params.jobId);
    if (!job) {
      res.status(404).json({ error: "Enrich job not found." });
      return;
    }
    if (job.status !== "done" || !job.csv_path || !fs.existsSync(job.csv_path)) {
      res.status(409).json({ error: job.error || "CSV not ready yet." });
      return;
    }
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="catalog_enriched.csv"');
    res.send(fs.readFileSync(job.csv_path, "utf8"));
  });

  app.get("/api/catalog", (_req, res) => {
    const p = path.join(PROJECT_ROOT, "out", "catalog_enriched.csv");
    if (!fs.existsSync(p)) {
      res.json({ rows: [] });
      return;
    }
    const text = fs.readFileSync(p, "utf8");
    const rows = parse(text, { columns: true, skip_empty_lines: true, trim: true });
    res.json({ rows });
  });
}
