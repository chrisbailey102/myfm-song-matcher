import crypto from "node:crypto";
import type { Express, Request, Response } from "express";
import multer from "multer";
import fs from "node:fs";
import path from "node:path";
import { parse } from "csv-parse/sync";
import { assertSpotifyConfigured, PROJECT_ROOT } from "./config.js";
import {
  readCatalogFromBuffer,
  enrichCatalog,
  enrichedSongsToCsvString,
} from "./catalog.js";
import { createJob, getJobById, listJobsForProject } from "./db/jobs.js";
import {
  createProject,
  getProjectById,
  listProjectsForUser,
} from "./db/projects.js";
import { listSongsForProject, updateSongOverrides } from "./db/songs.js";
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

  app.get("/api/projects", requireAuth, async (req, res) => {
    const projects = await listProjectsForUser(authed(req).id);
    res.json({ projects });
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
    const project = await getProjectById(req.params.id);
    if (!project || project.user_id !== authed(req).id) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    const pairs = await getProjectPairs(project.id);
    res.json({ pairs, count: pairs.length });
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

  /** Legacy Excel enrich (no login required) */
  app.post("/api/enrich", upload.single("file"), async (req, res) => {
    try {
      assertSpotifyConfigured();
      if (!req.file?.buffer?.length) {
        res.status(400).json({ error: "No file received. Choose a .xlsx and try again." });
        return;
      }
      const rows = readCatalogFromBuffer(req.file.buffer);
      const enriched = await enrichCatalog(rows, (i, t, label) => {
        console.error(`[enrich UI ${i}/${t}] ${label}`);
      });
      const csv = enrichedSongsToCsvString(enriched);
      const outDir = path.join(PROJECT_ROOT, "out");
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(path.join(outDir, "catalog_enriched.csv"), csv, "utf8");
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", 'attachment; filename="catalog_enriched.csv"');
      res.send(csv);
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
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
