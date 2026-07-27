import crypto from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import { assertSpotifyConfigured, optionalEnv, requireEnv } from "./config.js";
import { getUserById, updateUserTokens, upsertUser, type DbUser } from "./db/users.js";

const SCOPES = [
  "playlist-read-private",
  "playlist-read-collaborative",
  "user-read-email",
  "user-read-playback-state",
  "user-modify-playback-state",
].join(" ");

export function getAppBaseUrl(): string {
  return (optionalEnv("APP_BASE_URL") ?? "http://127.0.0.1:3847").replace(/\/$/, "");
}

export function getSpotifyRedirectUri(): string {
  return optionalEnv("SPOTIFY_REDIRECT_URI") ?? `${getAppBaseUrl()}/auth/spotify/callback`;
}

function sessionSecret(): string {
  const s = optionalEnv("SESSION_SECRET");
  if (!s || s.length < 16) {
    throw new Error(
      "SESSION_SECRET must be set (16+ random chars) in .env for Spotify login sessions.",
    );
  }
  return s;
}

function sign(payload: string): string {
  return crypto.createHmac("sha256", sessionSecret()).update(payload).digest("base64url");
}

export function setSessionUser(res: Response, userId: string): void {
  const payload = Buffer.from(JSON.stringify({ userId, exp: Date.now() + 30 * 86400_000 })).toString(
    "base64url",
  );
  const sig = sign(payload);
  res.cookie("song_matcher_session", `${payload}.${sig}`, {
    httpOnly: true,
    sameSite: "lax",
    secure: getAppBaseUrl().startsWith("https"),
    maxAge: 30 * 86400_000,
    path: "/",
  });
}

export function clearSession(res: Response): void {
  res.clearCookie("song_matcher_session", { path: "/" });
  res.clearCookie("myfm_session", { path: "/" });
}

export function readSessionUserId(req: Request): string | null {
  const raw =
    (req.cookies?.song_matcher_session as string | undefined) ||
    (req.cookies?.myfm_session as string | undefined);
  if (!raw) return null;
  const [payload, sig] = raw.split(".");
  if (!payload || !sig || sign(payload) !== sig) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      userId: string;
      exp: number;
    };
    if (!data.userId || data.exp < Date.now()) return null;
    return data.userId;
  } catch {
    return null;
  }
}

export async function getSessionUser(req: Request): Promise<DbUser | null> {
  const id = readSessionUserId(req);
  if (!id) return null;
  return getUserById(id);
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  getSessionUser(req)
    .then((user) => {
      if (!user) {
        res.status(401).json({ error: "Not logged in. Connect Spotify first." });
        return;
      }
      (req as Request & { user: DbUser }).user = user;
      next();
    })
    .catch(next);
}

export function buildSpotifyAuthorizeUrl(state: string): string {
  assertSpotifyConfigured();
  const clientId = requireEnv("SPOTIFY_CLIENT_ID");
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    redirect_uri: getSpotifyRedirectUri(),
    scope: SCOPES,
    state,
    show_dialog: "true",
  });
  return `https://accounts.spotify.com/authorize?${params.toString()}`;
}

export async function exchangeCodeForTokens(code: string): Promise<{
  access_token: string;
  refresh_token: string;
  expires_in: number;
}> {
  const clientId = requireEnv("SPOTIFY_CLIENT_ID");
  const clientSecret = requireEnv("SPOTIFY_CLIENT_SECRET");
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: getSpotifyRedirectUri(),
  });
  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      Authorization: "Basic " + Buffer.from(`${clientId}:${clientSecret}`).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });
  if (!res.ok) throw new Error(`Spotify token exchange failed: ${await res.text()}`);
  return res.json() as Promise<{
    access_token: string;
    refresh_token: string;
    expires_in: number;
  }>;
}

export async function refreshAccessToken(refreshToken: string): Promise<{
  access_token: string;
  expires_in: number;
}> {
  const clientId = requireEnv("SPOTIFY_CLIENT_ID");
  const clientSecret = requireEnv("SPOTIFY_CLIENT_SECRET");
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      Authorization: "Basic " + Buffer.from(`${clientId}:${clientSecret}`).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });
  if (!res.ok) throw new Error(`Spotify token refresh failed: ${await res.text()}`);
  return res.json() as Promise<{ access_token: string; expires_in: number }>;
}

export async function fetchSpotifyProfile(accessToken: string): Promise<{
  id: string;
  display_name: string | null;
}> {
  const res = await fetch("https://api.spotify.com/v1/me", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`Spotify profile failed: ${await res.text()}`);
  const j = (await res.json()) as { id: string; display_name: string | null };
  return { id: j.id, display_name: j.display_name };
}

export async function ensureUserAccessToken(user: DbUser): Promise<string> {
  if (user.token_expires_at > Date.now() + 60_000) {
    return user.access_token;
  }
  const tokens = await refreshAccessToken(user.refresh_token);
  const expires = Date.now() + tokens.expires_in * 1000;
  await updateUserTokens(user.id, tokens.access_token, expires);
  user.access_token = tokens.access_token;
  user.token_expires_at = expires;
  return tokens.access_token;
}

export async function loginWithSpotifyCode(code: string): Promise<DbUser> {
  const tokens = await exchangeCodeForTokens(code);
  const profile = await fetchSpotifyProfile(tokens.access_token);
  return upsertUser({
    spotify_id: profile.id,
    display_name: profile.display_name,
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    token_expires_at: Date.now() + tokens.expires_in * 1000,
  });
}
