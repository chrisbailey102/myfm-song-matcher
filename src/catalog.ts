import * as XLSX from "xlsx";
import { stringify } from "csv-stringify/sync";
import { parse } from "csv-parse/sync";
import fs from "node:fs";
import path from "node:path";
import type { CatalogRow, EnrichedSong } from "./types.js";
import {
  getTracksByIds,
  resolveBestTrack,
  searchTracksRadioHint,
  type SpotifyTrack,
} from "./spotify.js";
import { resolveTrackAudioMeta } from "./audioMeta.js";

function cellString(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "number" && Number.isFinite(v)) return String(Math.trunc(v));
  return String(v).trim();
}

function assertSpreadsheetExists(filePath: string): string {
  const abs = path.resolve(filePath);
  if (!fs.existsSync(abs)) {
    throw new Error(
      `Spreadsheet not found: ${abs}\n` +
        `  Use the real path to your .xlsx (the README example "/path/to/your.xlsx" is not a real file). ` +
        `Example: -i "./my-catalog.xlsx" or -i "/Users/you/Desktop/songs.xlsx"`,
    );
  }
  const st = fs.statSync(abs);
  if (!st.isFile()) {
    throw new Error(`Spreadsheet path is not a file: ${abs}`);
  }
  return abs;
}

function parseSheetRows(
  rows: Record<string, unknown>[],
): CatalogRow[] {
  const out: CatalogRow[] = [];
  for (const r of rows) {
    const keys = Object.keys(r);
    const lower = new Map(keys.map((k) => [k.toLowerCase().replace(/\s+/g, "_"), k]));
    const pick = (...names: string[]) => {
      for (const n of names) {
        const k = lower.get(n.toLowerCase());
        if (k && r[k] !== undefined && r[k] !== "") return cellString(r[k]);
      }
      return "";
    };
    const artist = pick("artist", "artists");
    const title = pick("title", "song", "track", "name");
    const year = pick("year", "yr");
    const spotify_id = pick("spotify_id", "spotifyid", "spotify track id");
    if (!artist || !title) continue;
    out.push({ artist, title, year: year || undefined, spotify_id: spotify_id || undefined });
  }
  if (out.length === 0) {
    throw new Error(
      "No rows with Artist+Title found. Use columns: Artist, Title, Year (optional), spotify_id (optional).",
    );
  }
  return out;
}

/** Read catalog from an in-memory .xlsx (e.g. browser upload). */
export function readCatalogFromBuffer(buf: Buffer): CatalogRow[] {
  const wb = XLSX.read(buf, { type: "buffer" });
  const sheetName = wb.SheetNames[0];
  if (!sheetName) throw new Error("Workbook has no sheets");
  const sheet = wb.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
    defval: "",
    raw: false,
  });
  return parseSheetRows(rows);
}

/**
 * Reads first sheet; maps columns case-insensitively.
 * Expected columns: Artist, Title, Year (optional), spotify_id (optional).
 */
export function readCatalogFromXlsx(filePath: string): CatalogRow[] {
  const abs = assertSpreadsheetExists(filePath);
  const buf = fs.readFileSync(abs);
  return readCatalogFromBuffer(buf);
}

const ENRICHED_COLUMNS = [
  "artist",
  "title",
  "year",
  "spotify_id_locked",
  "spotify_id_resolved",
  "spotify_url",
  "spotify_name",
  "spotify_artists",
  "duration_ms",
  "popularity",
  "spotify_key",
  "spotify_mode",
  "tempo",
  "time_signature",
  "energy",
  "danceability",
  "camelot",
  "match_confidence",
  "needs_review",
  "review_reason",
  "lyrics_source",
  "lyrics_fetched_at",
  "bpm_key_source",
] as const;

export function enrichedSongsToCsvString(songs: EnrichedSong[]): string {
  const records = songs.map((s) => ({
    artist: s.artist,
    title: s.title,
    year: s.year ?? "",
    spotify_id_locked: s.spotify_id ?? "",
    spotify_id_resolved: s.spotify_id_resolved,
    spotify_url: s.spotify_url,
    spotify_name: s.spotify_name,
    spotify_artists: s.spotify_artists,
    duration_ms: String(s.duration_ms),
    popularity: String(s.popularity),
    spotify_key: String(s.spotify_key),
    spotify_mode: String(s.spotify_mode),
    tempo: String(s.tempo),
    time_signature: String(s.time_signature),
    energy: String(s.energy),
    danceability: String(s.danceability),
    camelot: s.camelot,
    match_confidence: s.match_confidence.toFixed(4),
    needs_review: s.needs_review ? "true" : "false",
    review_reason: s.review_reason,
    lyrics_source: s.lyrics_source ?? "",
    lyrics_fetched_at: s.lyrics_fetched_at ?? "",
    bpm_key_source: s.bpm_key_source ?? "",
  }));
  return stringify(records, {
    header: true,
    columns: [...ENRICHED_COLUMNS],
  });
}

export function writeEnrichedCsv(songs: EnrichedSong[], outPath: string): void {
  const csv = enrichedSongsToCsvString(songs);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, csv, "utf8");
}

function stubTrackFromRow(row: CatalogRow, spotifyId: string): SpotifyTrack {
  return {
    id: spotifyId,
    name: row.title,
    duration_ms: 0,
    popularity: 0,
    external_urls: { spotify: `https://open.spotify.com/track/${spotifyId}` },
    artists: [{ name: row.artist.split(/[;/]/)[0]?.trim() || row.artist }],
    external_ids: row.isrc ? { isrc: row.isrc } : undefined,
  };
}

export async function enrichCatalog(
  rows: CatalogRow[],
  onProgress?: (i: number, total: number, label: string) => void,
): Promise<EnrichedSong[]> {
  const resolved: Array<{
    row: CatalogRow;
    track: SpotifyTrack;
    needs_review: boolean;
    review_reason: string;
    match_confidence: number;
  }> = Array(rows.length);

  const lockedIdx: number[] = [];
  const searchIdx: number[] = [];
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].spotify_id?.trim()) lockedIdx.push(i);
    else searchIdx.push(i);
  }

  // Playlist imports already have Spotify IDs — batch-fetch instead of 1 request/track.
  if (lockedIdx.length) {
    onProgress?.(0, rows.length, `Batch-loading ${lockedIdx.length} Spotify tracks…`);
    const ids = lockedIdx.map((i) => rows[i].spotify_id!.trim());
    let byId: Map<string, SpotifyTrack>;
    try {
      byId = await getTracksByIds(ids);
    } catch (e) {
      console.warn("Batch Spotify track fetch failed; using playlist stubs:", e);
      byId = new Map();
    }
    for (const i of lockedIdx) {
      const row = rows[i];
      const id = row.spotify_id!.trim();
      const track = byId.get(id) ?? stubTrackFromRow(row, id);
      resolved[i] = {
        row,
        track,
        needs_review: !byId.has(id),
        review_reason: byId.has(id) ? "locked_spotify_id" : "locked_spotify_id_stub",
        match_confidence: 1,
      };
    }
    onProgress?.(lockedIdx.length, rows.length, `Resolved ${lockedIdx.length} locked tracks`);
  }

  let done = lockedIdx.length;
  for (const i of searchIdx) {
    done++;
    const row = rows[i];
    onProgress?.(done, rows.length, `${row.artist} — ${row.title}`);
    const candidates = await searchTracksRadioHint(row.artist, row.title, "US");
    const r = resolveBestTrack(row.artist, row.title, candidates);
    resolved[i] = {
      row,
      track: r.chosen,
      needs_review: r.needs_review,
      review_reason: r.review_reason,
      match_confidence: r.match_confidence,
    };
    await sleep(200);
  }

  const audioMeta = await resolveTrackAudioMeta(resolved, (msg) => {
    console.error(msg);
    onProgress?.(rows.length, rows.length, msg);
  });
  return resolved.map(({ row, track, needs_review, review_reason, match_confidence }) => {
    const meta = audioMeta.get(track.id);
    const key = meta?.spotify_key ?? -1;
    const mode = meta?.spotify_mode ?? -1;
    const camelot = meta?.camelot ?? "";
    const noBpm = !meta?.tempo;
    const isrc = track.external_ids?.isrc?.trim() || row.isrc;
    return {
      ...row,
      isrc,
      spotify_id_resolved: track.id,
      spotify_url: track.external_urls?.spotify ?? "",
      spotify_name: track.name,
      spotify_artists: track.artists.map((a) => a.name).join("; "),
      duration_ms: track.duration_ms,
      popularity: track.popularity,
      spotify_key: key,
      spotify_mode: mode,
      tempo: meta?.tempo ?? 0,
      time_signature: meta?.time_signature ?? 0,
      energy: meta?.energy ?? 0,
      danceability: meta?.danceability ?? 0,
      camelot,
      match_confidence,
      needs_review: needs_review || noBpm || !camelot,
      review_reason:
        [review_reason, noBpm ? "missing_bpm" : "", !camelot ? "missing_key" : ""]
          .filter(Boolean)
          .join(";") || "ok",
      bpm_key_source: meta?.bpm_key_source ?? "",
    };
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function loadEnrichedCsv(csvPath: string): EnrichedSong[] {
  const abs = path.resolve(csvPath);
  if (!fs.existsSync(abs)) {
    throw new Error(
      `Enriched catalog CSV not found: ${abs}\n` +
        `  Run \`myfm enrich\` first, or pass the correct -c/--catalog path.`,
    );
  }
  const text = fs.readFileSync(abs, "utf8");
  const rows = parse(text, { columns: true, skip_empty_lines: true, trim: true }) as Record<
    string,
    string
  >[];
  const out: EnrichedSong[] = [];
  for (const r of rows) {
    const artist = r.artist ?? "";
    const title = r.title ?? "";
    if (!artist || !title) continue;
    out.push({
      artist,
      title,
      year: r.year || undefined,
      spotify_id: r.spotify_id_locked || undefined,
      spotify_id_resolved: r.spotify_id_resolved ?? "",
      spotify_url: r.spotify_url ?? "",
      spotify_name: r.spotify_name ?? "",
      spotify_artists: r.spotify_artists ?? "",
      duration_ms: Number(r.duration_ms) || 0,
      popularity: Number(r.popularity) || 0,
      spotify_key: Number(r.spotify_key),
      spotify_mode: Number(r.spotify_mode),
      tempo: Number(r.tempo) || 0,
      time_signature: Number(r.time_signature) || 0,
      energy: Number(r.energy) || 0,
      danceability: Number(r.danceability) || 0,
      camelot: r.camelot ?? "",
      match_confidence: Number(r.match_confidence) || 0,
      needs_review: (r.needs_review ?? "").toLowerCase() === "true",
      review_reason: r.review_reason ?? "",
      bpm_key_source: r.bpm_key_source ?? "",
    });
  }
  return out;
}
