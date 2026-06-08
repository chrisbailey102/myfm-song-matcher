import express from "express";
import fs from "node:fs";
import path from "node:path";
import multer from "multer";
import { parse } from "csv-parse/sync";
import { getUiPort, assertSpotifyConfigured, PROJECT_ROOT } from "./config.js";
import {
  readCatalogFromBuffer,
  enrichCatalog,
  enrichedSongsToCsvString,
} from "./catalog.js";

const app = express();
/** App files live next to package.json, not necessarily `process.cwd()` */
const root = PROJECT_ROOT;

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(root, "public")));

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

function readCsv(p: string): Record<string, string>[] {
  if (!fs.existsSync(p)) return [];
  const text = fs.readFileSync(p, "utf8");
  return parse(text, { columns: true, skip_empty_lines: true, trim: true }) as Record<
    string,
    string
  >[];
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

/**
 * Upload Excel → Spotify enrich → CSV download.
 * Also writes out/catalog_enriched.csv so “Load catalog” works after a run.
 */
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
    const outDir = path.join(root, "out");
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, "catalog_enriched.csv"), csv, "utf8");

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      'attachment; filename="catalog_enriched.csv"',
    );
    res.send(csv);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(e);
    res.status(500).json({ error: msg });
  }
});

app.get("/api/catalog", (_req, res) => {
  const p = path.join(root, "out", "catalog_enriched.csv");
  res.json({ rows: readCsv(p), path: p });
});

app.get("/api/pairs", (_req, res) => {
  const p = path.join(root, "out", "pair_candidates.csv");
  res.json({ rows: readCsv(p), path: p });
});

/** Multer / body-parser errors → JSON */
app.use(
  (
    err: unknown,
    _req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    if (res.headersSent) {
      next(err);
      return;
    }
    const msg = err instanceof Error ? err.message : String(err);
    res.status(400).json({ error: msg });
  },
);

const port = getUiPort();
const server = app.listen(port, "127.0.0.1", () => {
  console.error(`MyFM Song Matcher UI: http://127.0.0.1:${port}/`);
  console.error("(Leave this terminal open while you use the app. Press Ctrl+C to stop.)");
});
/** Large catalogs hit Spotify for each row — allow long requests */
server.setTimeout(20 * 60 * 1000);
