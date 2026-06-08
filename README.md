# MyFM Song Matcher

**Node 20+** web app + CLI for mashup research: import **Spotify playlists** (including private), enrich BPM/key, score harmonic + lyric pairs, and **override BPM/Camelot** in the UI.

## Prerequisites

- [Spotify Developer](https://developer.spotify.com/dashboard) app — Client ID + Secret, with **Redirect URI** set (see below).
- **Postgres** — local via Docker, or Railway Postgres in production.
- [GetSongBPM API key](https://getsongbpm.com/api) — BPM/key when Spotify blocks audio-features on new apps.
- Optional: [Genius](https://genius.com/api-clients) for lyrics (CLI).

## Quick start (local)

```bash
cd myfm-song-matcher
cp .env.example .env
# Fill SPOTIFY_*, SESSION_SECRET, DATABASE_URL, GETSONGBPM_API_KEY
docker compose up -d db
npm install
npm run dev
```

Open **http://127.0.0.1:3847/** → **Connect Spotify** → paste a **private or public playlist URL** → **Import & enrich**.

### Spotify Dashboard → Redirect URIs

Add exactly (local):

`http://127.0.0.1:3847/auth/spotify/callback`

For Railway, also add your production URL (see Deploy section).

### Required env vars

| Variable | Purpose |
|----------|---------|
| `SPOTIFY_CLIENT_ID` / `SPOTIFY_CLIENT_SECRET` | API + OAuth |
| `SPOTIFY_REDIRECT_URI` | Must match Dashboard |
| `APP_BASE_URL` | e.g. `http://127.0.0.1:3847` |
| `SESSION_SECRET` | 32+ random chars for login cookies |
| `DATABASE_URL` | `postgresql://myfm:myfm@localhost:5432/myfm` (with `docker compose up -d db`) |
| `GETSONGBPM_API_KEY` | BPM/key fallback |

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

## Web app features (Phase 1)

- **Spotify OAuth** — read private playlists
- **Playlist import** — URL or picker from your library
- **Background enrich job** — BPM/key + metadata per track
- **Manual overrides** — edit `tempo_override` / `camelot_override` per song (used for pairing)
- **Pair candidates** — harmonic scores for the project catalog
- **Legacy Excel upload** — collapsible section at bottom of page

## Deploy to Railway

1. Create a new Railway project from this repo.
2. Add a **PostgreSQL** plugin; Railway sets `DATABASE_URL` automatically.
3. Set variables: `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`, `SESSION_SECRET`, `GETSONGBPM_API_KEY`, `APP_BASE_URL` (your Railway URL), `SPOTIFY_REDIRECT_URI` (`{APP_BASE_URL}/auth/spotify/callback`).
4. Add the same redirect URI in the Spotify Developer Dashboard.
5. Deploy — `railway.toml` runs `node dist/server.js` after Docker build.

## Docker (app + Postgres)

```bash
docker compose up --build
# http://127.0.0.1:3847/
```

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
- `src/spotifyAuth.ts` — OAuth + sessions  
- `src/spotifyPlaylist.ts` — playlist import  
- `src/db/` — Postgres schema + projects/songs/jobs  
- `src/worker.ts` — background enrich jobs  
- `src/server.ts` + `public/` — web UI  

## License

Private / internal use unless you add a license file for redistribution.
