import dotenv from "dotenv";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** Project root (parent of `src/` or `dist/`) */
export const PROJECT_ROOT = path.resolve(__dirname, "..");
const ENV_PATH = path.join(PROJECT_ROOT, ".env");
const SPOTIFY_ENV_PATH = path.join(PROJECT_ROOT, "spotify-key.env");

/**
 * Load `spotify-key.env` first, then `.env`.
 * (If `.env` is loaded first with empty `SPOTIFY_CLIENT_ID=`, dotenv will not
 * replace it when `spotify-key.env` loads — credentials look "missing".)
 */
dotenv.config({ path: SPOTIFY_ENV_PATH });
dotenv.config({ path: ENV_PATH });

export function envFilePath(): string {
  return ENV_PATH;
}

export function spotifyEnvFilePath(): string {
  return SPOTIFY_ENV_PATH;
}

export function envFileExists(): boolean {
  return fs.existsSync(ENV_PATH) || fs.existsSync(SPOTIFY_ENV_PATH);
}

export function assertSpotifyConfigured(): void {
  const id = process.env.SPOTIFY_CLIENT_ID?.trim();
  const secret = process.env.SPOTIFY_CLIENT_SECRET?.trim();
  if (id && secret) return;
  const hasDot = fs.existsSync(ENV_PATH);
  const hasSpotifyFile = fs.existsSync(SPOTIFY_ENV_PATH);
  const hint =
    hasDot || hasSpotifyFile
      ? `Spotify variables are missing or empty.\n` +
        `  Put SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET in:\n` +
        `    - ${ENV_PATH}${hasDot ? " (exists)" : " (missing)"}\n` +
        `    and/or\n` +
        `    - ${SPOTIFY_ENV_PATH}${hasSpotifyFile ? " (exists)" : " (missing)"}\n` +
        `  (same names as in .env.example). Get values from https://developer.spotify.com/dashboard → your app → Settings.`
      : `No env file found.\n` +
        `  Create ${ENV_PATH} (see .env.example) and/or ${SPOTIFY_ENV_PATH} with your Spotify Client ID and Secret.`;
  throw new Error(`Spotify API credentials are not configured.\n${hint}`);
}

export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return v;
}

export function optionalEnv(name: string): string | undefined {
  return process.env[name];
}

export function getMaxPairs(): number {
  const raw = process.env.MYFM_MAX_PAIRS;
  if (!raw) return 500_000;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 500_000;
}

export function getUiPort(): number {
  // Railway injects PORT; prefer it in production so healthchecks work.
  const raw = process.env.PORT ?? process.env.MYFM_UI_PORT ?? "3847";
  const n = Number(raw);
  return Number.isFinite(n) ? Math.floor(n) : 3847;
}

export function getBpmTolerance(): number {
  const raw = process.env.MYFM_BPM_TOLERANCE ?? "10";
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 10;
}
