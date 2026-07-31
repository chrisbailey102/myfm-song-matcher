import type { Request, Response, NextFunction, Express } from "express";
import { jwtVerify } from "jose";
import { optionalEnv } from "./config.js";

export const OTS_SESSION_COOKIE = "ots_session";

export type OtsSessionClaims = {
  sub: string;
  email: string;
};

function sessionSecret(): Uint8Array | null {
  const raw = optionalEnv("SESSION_JWT_SECRET")?.trim();
  if (!raw) return null;
  return new TextEncoder().encode(raw);
}

export function isTeamAuthEnabled(): boolean {
  return Boolean(sessionSecret());
}

export async function verifyOtsSessionToken(
  token: string,
): Promise<OtsSessionClaims | null> {
  const secret = sessionSecret();
  if (!secret) return null;
  try {
    const { payload } = await jwtVerify(token, secret, {
      issuer: "onthesly",
      algorithms: ["HS256"],
    });
    const sub = typeof payload.sub === "string" ? payload.sub : "";
    const email = typeof payload.email === "string" ? payload.email : "";
    if (!sub) return null;
    return { sub, email };
  } catch {
    return null;
  }
}

export function readOtsSessionCookie(req: Request): string | null {
  const raw = req.cookies?.[OTS_SESSION_COOKIE];
  return typeof raw === "string" && raw.length > 0 ? raw : null;
}

export async function getTeamSession(
  req: Request,
): Promise<OtsSessionClaims | null> {
  if (!isTeamAuthEnabled()) return null;
  const token = readOtsSessionCookie(req);
  if (!token) return null;
  return verifyOtsSessionToken(token);
}

export async function isTeamAuthed(req: Request): Promise<boolean> {
  if (!isTeamAuthEnabled()) return true;
  return Boolean(await getTeamSession(req));
}

export async function requireSiteAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  if (!isTeamAuthEnabled()) {
    next();
    return;
  }
  const session = await getTeamSession(req);
  if (!session) {
    res.status(401).json({
      error: "Team login required",
      message: "Team login required",
    });
    return;
  }
  next();
}

function clearOtsSessionCookie(req: Request, res: Response): void {
  const host = String(req.hostname || "").toLowerCase();
  const onOnthesly = host === "onthesly.com" || host.endsWith(".onthesly.com");
  const base = {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: onOnthesly || process.env.NODE_ENV === "production",
    path: "/",
  };
  res.clearCookie(OTS_SESSION_COOKIE, base);
  if (onOnthesly) {
    res.clearCookie(OTS_SESSION_COOKIE, { ...base, domain: ".onthesly.com" });
  }
  res.clearCookie("site_auth", base);
  if (onOnthesly) {
    res.clearCookie("site_auth", { ...base, domain: ".onthesly.com" });
  }
}

export function registerSiteAuthRoutes(app: Express): void {
  app.get("/api/site-auth/status", async (req, res) => {
    if (!isTeamAuthEnabled()) {
      res.json({ enabled: false, authenticated: true });
      return;
    }
    const session = await getTeamSession(req);
    res.json({
      enabled: true,
      authenticated: Boolean(session),
      email: session?.email || null,
    });
  });

  app.get("/api/auth/status", async (req, res) => {
    if (!isTeamAuthEnabled()) {
      res.json({ enabled: false, authenticated: true });
      return;
    }
    const session = await getTeamSession(req);
    res.json({
      enabled: true,
      authenticated: Boolean(session),
      email: session?.email || null,
    });
  });

  app.post("/api/site-auth/login", (_req, res) => {
    res.status(410).json({
      ok: false,
      message: "Team password login retired. Sign in at dashboard.onthesly.com",
    });
  });

  app.post("/api/site-auth/logout", (req, res) => {
    clearOtsSessionCookie(req, res);
    res.json({ ok: true });
  });
}
