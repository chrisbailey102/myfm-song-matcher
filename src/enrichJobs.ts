import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { PROJECT_ROOT } from "./config.js";
import {
  enrichCatalog,
  enrichedSongsToCsvString,
  readCatalogFromBuffer,
} from "./catalog.js";

export type EnrichJobStatus = {
  id: string;
  status: "running" | "done" | "failed";
  progress: number;
  progress_total: number;
  progress_label: string;
  error?: string;
  csv_path?: string;
  created_at: number;
};

const jobs = new Map<string, EnrichJobStatus>();

export function getEnrichJob(id: string): EnrichJobStatus | null {
  return jobs.get(id) ?? null;
}

export function startEnrichJob(fileBuffer: Buffer): EnrichJobStatus {
  const id = crypto.randomUUID();
  const job: EnrichJobStatus = {
    id,
    status: "running",
    progress: 0,
    progress_total: 0,
    progress_label: "Parsing spreadsheet…",
    created_at: Date.now(),
  };
  jobs.set(id, job);

  void (async () => {
    try {
      const rows = readCatalogFromBuffer(fileBuffer);
      job.progress_total = rows.length;
      job.progress_label = `Matching ${rows.length} songs…`;
      const enriched = await enrichCatalog(rows, (i, t, label) => {
        job.progress = i;
        job.progress_total = t;
        job.progress_label = label;
      });
      const csv = enrichedSongsToCsvString(enriched);
      const outDir = path.join(PROJECT_ROOT, "out");
      fs.mkdirSync(outDir, { recursive: true });
      const csvPath = path.join(outDir, `catalog_enriched_${id}.csv`);
      fs.writeFileSync(csvPath, csv, "utf8");
      // Keep latest convenience copy for CLI/tools
      fs.writeFileSync(path.join(outDir, "catalog_enriched.csv"), csv, "utf8");
      job.csv_path = csvPath;
      job.status = "done";
      job.progress = job.progress_total;
      job.progress_label = `Done — ${enriched.length} songs`;
    } catch (e) {
      job.status = "failed";
      job.error = e instanceof Error ? e.message : String(e);
      job.progress_label = "Failed";
    }
  })();

  // Drop old jobs after 2h
  const cutoff = Date.now() - 2 * 3600_000;
  for (const [k, v] of jobs) {
    if (v.created_at < cutoff) jobs.delete(k);
  }

  return job;
}
