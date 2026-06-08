#!/usr/bin/env node
import { Command } from "commander";
import path from "node:path";
import { assertSpotifyConfigured } from "./config.js";
import {
  readCatalogFromXlsx,
  enrichCatalog,
  writeEnrichedCsv,
  loadEnrichedCsv,
} from "./catalog.js";
import { ensureLyricsOnDisk } from "./lyrics.js";
import { generatePairCandidates, writePairCsv } from "./pairs.js";

const program = new Command();

program
  .name("myfm")
  .description("MyFM Song Matcher — enrich catalog, fetch lyrics, generate harmonic + lyric pair candidates.")
  .version("0.1.0");

program
  .command("enrich")
  .description("Read Excel catalog, resolve Spotify tracks (US market heuristics), write catalog_enriched.csv")
  .requiredOption("-i, --input <xlsx>", "Path to .xlsx (Artist, Title, Year optional, spotify_id optional)")
  .option("-o, --out <csv>", "Output CSV path", "out/catalog_enriched.csv")
  .action(async (opts: { input: string; out: string }) => {
    assertSpotifyConfigured();
    const rows = readCatalogFromXlsx(path.resolve(opts.input));
    console.error(`Loaded ${rows.length} rows from ${opts.input}`);
    const enriched = await enrichCatalog(rows, (i, t, label) => {
      console.error(`[${i}/${t}] ${label}`);
    });
    writeEnrichedCsv(enriched, path.resolve(opts.out));
    console.error(`Wrote ${enriched.length} rows to ${opts.out}`);
  });

program
  .command("lyrics")
  .description("Fetch Genius lyrics into out/lyrics/<spotify_id>.txt and update metadata columns on enriched CSV")
  .requiredOption("-c, --catalog <csv>", "Path to catalog_enriched.csv from enrich")
  .option("-d, --dir <folder>", "Lyrics cache directory", "out/lyrics")
  .option("--force", "Re-fetch even if .txt exists", false)
  .action(async (opts: { catalog: string; dir: string; force?: boolean }) => {
    const songs = loadEnrichedCsv(path.resolve(opts.catalog));
    if (!process.env.GENIUS_ACCESS_TOKEN) {
      console.error("GENIUS_ACCESS_TOKEN missing — set in .env to fetch lyrics.");
      process.exit(1);
    }
    let ok = 0;
    let i = 0;
    for (const s of songs) {
      i++;
      console.error(`[${i}/${songs.length}] ${s.artist} — ${s.title}`);
      const r = await ensureLyricsOnDisk(s, path.resolve(opts.dir), !!opts.force);
      if (r.ok) {
        ok++;
        s.lyrics_source = r.source === "cache" ? "genius_cache" : "genius";
        s.lyrics_fetched_at = new Date().toISOString();
      } else {
        s.lyrics_source = "";
        s.lyrics_fetched_at = "";
      }
      await new Promise((res) => setTimeout(res, 400));
    }
    writeEnrichedCsv(songs, path.resolve(opts.catalog));
    console.error(`Lyrics on disk: ${ok}/${songs.length}. Updated ${opts.catalog}`);
  });

program
  .command("pairs")
  .description("Generate pair_candidates.csv from enriched catalog (harmonic + optional lyric scores)")
  .requiredOption("-c, --catalog <csv>", "catalog_enriched.csv")
  .option("-d, --lyrics-dir <folder>", "Lyrics folder from `myfm lyrics`", "out/lyrics")
  .option("--no-lyrics", "Skip lyric files; harmonic-only scores")
  .option("-o, --out <csv>", "Output pairs CSV", "out/pair_candidates.csv")
  .action(
    async (opts: { catalog: string; lyricsDir: string; lyrics: boolean; out: string }) => {
      const songs = loadEnrichedCsv(path.resolve(opts.catalog));
      const withLyrics = opts.lyrics !== false;
      const lyricsDir = withLyrics ? path.resolve(opts.lyricsDir) : undefined;
      const pairs = generatePairCandidates({ songs, lyricsDir, withLyrics });
      writePairCsv(pairs, path.resolve(opts.out));
      console.error(`Wrote ${pairs.length} pairs to ${opts.out}`);
    },
  );

program
  .command("all")
  .description("Run enrich → lyrics → pairs (requires Spotify + Genius env)")
  .requiredOption("-i, --input <xlsx>", "Input .xlsx")
  .option("--catalog <csv>", "Enriched CSV path", "out/catalog_enriched.csv")
  .option("--pairs <csv>", "Pairs CSV path", "out/pair_candidates.csv")
  .option("--lyrics-dir <folder>", "Lyrics dir", "out/lyrics")
  .action(
    async (opts: {
      input: string;
      catalog: string;
      pairs: string;
      lyricsDir: string;
    }) => {
      assertSpotifyConfigured();
      const catalogPath = path.resolve(opts.catalog);
      const rows = readCatalogFromXlsx(path.resolve(opts.input));
      const enriched = await enrichCatalog(rows, (i, t, l) =>
        console.error(`[enrich ${i}/${t}] ${l}`),
      );
      writeEnrichedCsv(enriched, catalogPath);
      if (!process.env.GENIUS_ACCESS_TOKEN) {
        console.error("Skipping lyrics: set GENIUS_ACCESS_TOKEN for Genius fetch.");
        const pairs = generatePairCandidates({
          songs: enriched,
          withLyrics: false,
        });
        writePairCsv(pairs, path.resolve(opts.pairs));
      } else {
        const lyricsDir = path.resolve(opts.lyricsDir);
        for (const s of enriched) {
          const r = await ensureLyricsOnDisk(s, lyricsDir, false);
          if (r.ok) {
            s.lyrics_source = r.source === "cache" ? "genius_cache" : "genius";
            s.lyrics_fetched_at = new Date().toISOString();
          } else {
            s.lyrics_source = "";
            s.lyrics_fetched_at = "";
          }
          await new Promise((res) => setTimeout(res, 400));
        }
        writeEnrichedCsv(enriched, catalogPath);
        const pairs = generatePairCandidates({
          songs: enriched,
          lyricsDir,
          withLyrics: true,
        });
        writePairCsv(pairs, path.resolve(opts.pairs));
      }
      console.error("Done.");
    },
  );

program.parseAsync(process.argv).catch((e) => {
  console.error(e);
  process.exit(1);
});
