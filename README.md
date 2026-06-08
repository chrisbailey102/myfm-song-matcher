# MyFM Song Matcher

Small **Node 20+** toolkit to speed up short mashup research: enrich an Excel song list with **Spotify key/BPM** (US market + “radio edit” heuristics), optionally cache **Genius** lyrics, then emit **harmonically compatible** pair candidates with **lyric bridge hints**.

## Prerequisites

- [Spotify Developer](https://developer.spotify.com/dashboard) app — **Client ID** and **Client Secret** (Client Credentials flow; no user login).
- Optional: [Genius API](https://genius.com/api-clients) access token for lyrics.

## Setup

```bash
cd myfm-song-matcher
cp .env.example .env
# Edit .env in THIS project folder (next to package.json), not only in your home directory.
# Add SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET from the Spotify Developer Dashboard.
# Optional: GENIUS_ACCESS_TOKEN for lyrics.
npm install
npm run build
```

Spotify credentials use the **Client Credentials** flow: in the Spotify app dashboard open your app → **Settings** → copy **Client ID** and **Client Secret** (not the redirect URI flow).

## Excel format

First worksheet, columns (case-insensitive headers):

| Artist | Title | Year (optional) | spotify_id (optional) |
|--------|-------|-----------------|------------------------|

If `spotify_id` is set, that track is **locked** (no search). Use this after you confirm the correct US radio / single version.

## CLI

Run from project root (with `.env` present):

```bash
# 1) Enrich catalog → out/catalog_enriched.csv
# Replace ./my-catalog.xlsx with the real path to your Excel file.
npm run myfm -- enrich -i ./my-catalog.xlsx -o out/catalog_enriched.csv

# 2) Fetch lyrics → out/lyrics/<spotify_id>.txt + update CSV columns
npm run myfm -- lyrics -c out/catalog_enriched.csv -d out/lyrics

# 3) Pair candidates → out/pair_candidates.csv
npm run myfm -- pairs -c out/catalog_enriched.csv -d out/lyrics -o out/pair_candidates.csv

# Harmonic only (no lyric files)
npm run myfm -- pairs -c out/catalog_enriched.csv --no-lyrics

# One-shot (lyrics step skipped if GENIUS_ACCESS_TOKEN unset)
npm run myfm -- all -i ./my-catalog.xlsx
```

### Environment tuning

| Variable | Default | Purpose |
|----------|---------|---------|
| `MYFM_BPM_TOLERANCE` | `10` | Max BPM difference for a pair |
| `MYFM_MAX_PAIRS` | `500000` | Safety cap on pair rows |
| `MYFM_UI_PORT` | `3847` | Local review UI port |

## Local app (pick Excel in the browser)

From the project folder:

```bash
npm run start:ui
```

**Important:** `npm run build` only compiles TypeScript — it does **not** start the browser app. You must run **`npm run start:ui`** and **leave that terminal open**. Then open the URL it prints (usually below).

After a build, you can instead run: **`npm run start:ui:dist`** (same UI, uses `dist/`).

Open **http://127.0.0.1:3847/** — use **“Enrich from Excel”** to choose your `.xlsx` file and run Spotify enrichment in the browser. When it finishes you get a **download** of `catalog_enriched.csv`, and a copy is saved under **`out/catalog_enriched.csv`** so **Load catalog** works.

Spotify credentials still come from the server’s **`.env`** or **`spotify-key.env`** (not from the browser). Large catalogs can take many minutes; the page waits up to **20 minutes** for one upload.

## Local review UI (browse CSVs)

Use **Load catalog** / **Load pairs** in the same page after those files exist under `out/`.

Share **`out/*.csv`** (and optionally `out/lyrics/`) with a colleague via your normal internal channel; they only need Node + this repo + the same files.

## Docker (optional)

```bash
docker compose up --build
# UI: http://127.0.0.1:3847/ — mount your ./out and .env as in docker-compose.yml
```

Mount a host directory that contains `out/` and place `catalog.xlsx` then run CLI inside the container if desired.

## Data sources & compliance

- **Spotify** — track search works on new developer apps. **Audio Features (BPM/key) often return 403** for apps created after Nov 2024 ([Spotify blog](https://developer.spotify.com/blog/2024-11-27-changes-to-the-web-api)). Set **`GETSONGBPM_API_KEY`** ([free at getsongbpm.com/api](https://getsongbpm.com/api)) in `.env` or `spotify-key.env` and MyFM will use that for tempo/Camelot instead.
- **Genius** — via the `genius-lyrics` package (scrapes lyric pages). Check [Genius API Terms](https://genius.com/static/terms) for your use case. Do **not** rely on Tunebat scraping (fragile / ToS risk); this tool does not implement it.

## Project layout

- `src/catalog.ts` — XLSX → rows, enrich, CSV I/O  
- `src/spotify.ts` — token, search, audio-features, resolver scoring  
- `src/camelot.ts` — Spotify key/mode → Camelot, MIK-style compatibility  
- `src/lyrics.ts` — Genius fetch + lyric pair scoring  
- `src/pairs.ts` — candidate generation + `pair_candidates.csv`  
- `src/cli.ts` — Commander CLI  
- `src/server.ts` + `public/` — minimal internal UI  

## License

Private / internal use unless you add a license file for redistribution.
