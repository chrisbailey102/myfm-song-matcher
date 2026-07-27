import type { Request, Response, NextFunction, Express } from "express";
import { optionalEnv } from "./config.js";

export const SITE_AUTH_COOKIE = "site_auth";

function appPassword(): string {
  return optionalEnv("APP_PASSWORD")?.trim() || "";
}

export function isSiteAuthEnabled(): boolean {
  return Boolean(appPassword());
}

export function isSiteAuthed(req: Request): boolean {
  return req.signedCookies?.[SITE_AUTH_COOKIE] === "ok";
}

/** Shared across *.onthesly.com so dashboard login unlocks Song Matcher. */
export function siteAuthCookieOptions(req: Request) {
  const host = String(req.hostname || "").toLowerCase();
  const onOnthesly = host === "onthesly.com" || host.endsWith(".onthesly.com");
  return {
    httpOnly: true,
    signed: true as const,
    sameSite: "lax" as const,
    secure: onOnthesly || process.env.NODE_ENV === "production",
    maxAge: 1000 * 60 * 60 * 12,
    path: "/",
    ...(onOnthesly ? { domain: ".onthesly.com" } : {}),
  };
}

export function requireSiteAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (!isSiteAuthEnabled()) {
    next();
    return;
  }
  if (isSiteAuthed(req)) {
    next();
    return;
  }
  res.status(401).json({ error: "App password required", message: "App password required" });
}

export function registerSiteAuthRoutes(app: Express): void {
  app.get("/api/site-auth/status", (req, res) => {
    if (!isSiteAuthEnabled()) {
      res.json({ enabled: false, authenticated: true });
      return;
    }
    res.json({
      enabled: true,
      authenticated: isSiteAuthed(req),
    });
  });

  app.post("/api/site-auth/login", (req, res) => {
    if (!isSiteAuthEnabled()) {
      res.json({ ok: true, authenticated: true });
      return;
    }
    const password = String((req.body as { password?: string })?.password || "");
    if (password !== appPassword()) {
      res.status(401).json({ ok: false, message: "Invalid password" });
      return;
    }
    res.cookie(SITE_AUTH_COOKIE, "ok", siteAuthCookieOptions(req));
    res.json({ ok: true, authenticated: true });
  });

  app.post("/api/site-auth/logout", (req, res) => {
    res.clearCookie(SITE_AUTH_COOKIE, siteAuthCookieOptions(req));
    res.json({ ok: true });
  });
}
