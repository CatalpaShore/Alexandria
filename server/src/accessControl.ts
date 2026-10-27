import crypto from "node:crypto";
import type { Express, NextFunction, Request, Response } from "express";

type AccessControlOptions = {
  lanMode: boolean;
  requireAuthentication?: boolean;
  accessToken?: string;
  pairingCode?: string;
  allowedOrigins?: string[];
  trustProxy?: boolean;
  sessionTtlSeconds?: number;
};

type FailedAttempt = { count: number; resetAt: number };

const SESSION_COOKIE = "amw_session";
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function parseCookies(header: string | undefined): Map<string, string> {
  const cookies = new Map<string, string>();
  for (const entry of (header ?? "").split(";")) {
    const separator = entry.indexOf("=");
    if (separator < 1) continue;
    const key = entry.slice(0, separator).trim();
    const value = entry.slice(separator + 1).trim();
    if (!key) continue;
    try { cookies.set(key, decodeURIComponent(value)); } catch { cookies.set(key, value); }
  }
  return cookies;
}

function authorizationCredential(req: Request): string | null {
  const authorization = req.get("authorization") ?? "";
  if (/^Bearer\s+/iu.test(authorization)) return authorization.replace(/^Bearer\s+/iu, "").trim();
  if (/^Basic\s+/iu.test(authorization)) {
    try {
      const decoded = Buffer.from(authorization.replace(/^Basic\s+/iu, ""), "base64").toString("utf8");
      const separator = decoded.indexOf(":");
      return separator >= 0 ? decoded.slice(separator + 1) : decoded;
    } catch {
      return null;
    }
  }
  return req.get("x-amw-access-token")?.trim() || null;
}

function firstHeader(value: string | undefined): string {
  return value?.split(",")[0]?.trim() ?? "";
}

function normalizedOrigin(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

function requestOriginAllowed(
  req: Request,
  allowedOrigins: Set<string>,
  trustProxy: boolean
): boolean {
  const origin = normalizedOrigin(firstHeader(req.get("origin")));
  if (!origin) return !req.get("origin");
  if (allowedOrigins.has(origin)) return true;

  const parsedOrigin = new URL(origin);
  const requestHost = firstHeader(req.get("host"));
  if (requestHost && parsedOrigin.host === requestHost.toLowerCase()) return true;
  if (!trustProxy) return false;

  const forwardedHost = firstHeader(req.get("x-forwarded-host")).toLowerCase();
  const forwardedProtocol = firstHeader(req.get("x-forwarded-proto")).toLowerCase();
  if (forwardedHost) {
    const forwardedPublicOrigin = normalizedOrigin(
      `${forwardedProtocol === "https" ? "https" : "http"}://${forwardedHost}`
    );
    if (forwardedPublicOrigin === origin) return true;
  }

  const forwardedOrigin = normalizedOrigin(firstHeader(req.get("x-forwarded-origin")));
  if (!forwardedOrigin) return false;
  if (allowedOrigins.has(forwardedOrigin)) return true;
  if (!forwardedHost) return false;
  const parsedForwardedOrigin = new URL(forwardedOrigin);
  return parsedForwardedOrigin.host === forwardedHost
    && (!forwardedProtocol || parsedForwardedOrigin.protocol === `${forwardedProtocol}:`);
}

export function createAccessControl(options: AccessControlOptions) {
  const requiresAuthentication = options.lanMode && options.requireAuthentication === true;
  const mode = !options.lanMode
    ? "local-only" as const
    : requiresAuthentication
      ? "lan-protected" as const
      : "lan-open" as const;
  const sessionTtlSeconds = Math.max(300, options.sessionTtlSeconds ?? 30 * 24 * 60 * 60);
  const accessToken = options.accessToken?.trim() || crypto.randomBytes(32).toString("base64url");
  const pairingCode = options.pairingCode?.trim() || String(crypto.randomInt(100_000, 1_000_000));
  const sessionValue = crypto.createHmac("sha256", accessToken).update("alexandria-lan-session-v1").digest("base64url");
  const allowedOrigins = new Set(
    (options.allowedOrigins ?? [])
      .map((value) => normalizedOrigin(value.trim()))
      .filter((value): value is string => Boolean(value))
  );
  const failedAttempts = new Map<string, FailedAttempt>();

  function isAuthenticated(req: Request): boolean {
    if (!requiresAuthentication) return true;
    const cookie = parseCookies(req.get("cookie")).get(SESSION_COOKIE);
    if (cookie && safeEqual(cookie, sessionValue)) return true;
    const credential = authorizationCredential(req);
    return Boolean(credential && safeEqual(credential, accessToken));
  }

  function rejectUnauthorized(res: Response): void {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("WWW-Authenticate", 'Basic realm="Alexandria", charset="UTF-8"');
    res.status(401).json({
      code: "AMW_AUTH_REQUIRED",
      error: "此 Alexandria 18+ 服务已启用局域网保护，请先输入启动终端显示的配对码。"
    });
  }

  function middleware(req: Request, res: Response, next: NextFunction): void {
    res.setHeader("X-AMW-Network-Mode", mode);
    if (!options.lanMode) {
      next();
      return;
    }
    if (requiresAuthentication && !isAuthenticated(req)) {
      rejectUnauthorized(res);
      return;
    }
    if (!SAFE_METHODS.has(req.method) && !requestOriginAllowed(req, allowedOrigins, options.trustProxy === true)) {
      res.status(403).json({ code: "AMW_ORIGIN_REJECTED", error: "写操作来源与当前 Alexandria 18+ 服务不一致。" });
      return;
    }
    next();
  }

  function register(app: Express): void {
    app.get("/api/access/status", (req, res) => {
      res.setHeader("Cache-Control", "no-store");
      res.json({
        mode,
        requiresAuthentication,
        authenticated: isAuthenticated(req)
      });
    });

    app.post("/api/access/pair", (req, res) => {
      res.setHeader("Cache-Control", "no-store");
      if (!requiresAuthentication) {
        res.json({ authenticated: true, mode });
        return;
      }
      const clientKey = req.ip || req.socket.remoteAddress || "unknown";
      const now = Date.now();
      const failed = failedAttempts.get(clientKey);
      if (failed && failed.resetAt > now && failed.count >= 5) {
        res.status(429).json({ error: "配对尝试过多，请五分钟后再试。" });
        return;
      }
      const candidate = typeof req.body?.code === "string" ? req.body.code.trim() : "";
      if (!candidate || !safeEqual(candidate, pairingCode)) {
        const current = failed && failed.resetAt > now ? failed : { count: 0, resetAt: now + 5 * 60_000 };
        failedAttempts.set(clientKey, { ...current, count: current.count + 1 });
        res.status(401).json({ error: "配对码不正确，请核对启动终端中的六位数字。" });
        return;
      }
      failedAttempts.delete(clientKey);
      const secure = req.secure;
      const cookie = [
        `${SESSION_COOKIE}=${encodeURIComponent(sessionValue)}`,
        "Path=/",
        "HttpOnly",
        "SameSite=Strict",
        `Max-Age=${sessionTtlSeconds}`,
        ...(secure ? ["Secure"] : [])
      ].join("; ");
      res.setHeader("Set-Cookie", cookie);
      res.json({ authenticated: true, mode: "lan-protected" });
    });

    app.post("/api/access/logout", (_req, res) => {
      res.setHeader("Set-Cookie", `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
      res.status(204).end();
    });

    app.use("/api", middleware);
  }

  return {
    register,
    middleware,
    isAuthenticated,
    getPairingCode: () => pairingCode,
    getAccessToken: () => accessToken,
    mode
  };
}
