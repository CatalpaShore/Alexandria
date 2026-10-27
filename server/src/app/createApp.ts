import path from "node:path";
import compression from "compression";
import express from "express";
import helmet from "helmet";
import { ZodError } from "zod";
import { diagnosticsMiddleware } from "../diagnostics.js";
import { registerRoutes } from "../routes.js";
import { createAccessControl } from "../accessControl.js";
import { config } from "../config.js";
import { demoAccess, demoStaticAccess } from "../demoAccess.js";
import { demoFilmExperience } from "../demoSeed.js";

export const accessControl = createAccessControl({
  lanMode: config.network.lanMode,
  requireAuthentication: config.network.requireAuthentication,
  accessToken: config.network.accessToken,
  pairingCode: config.network.pairingCode,
  allowedOrigins: config.network.allowedOrigins,
  trustProxy: config.network.trustProxy
});

export function createApp(): express.Express {
  const app = express();
  const allowFrameEmbedding = (process.env.AMW_ALLOW_FRAME_EMBEDDING ?? "false")
    .trim()
    .toLowerCase() === "true";
  app.set("trust proxy", config.network.trustProxy ? 1 : false);

  app.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginResourcePolicy: false,
      // ZSpace opens Docker shortcuts inside an iframe served from its
      // management port. Keep framing blocked unless that deployment opts in.
      frameguard: allowFrameEmbedding ? false : undefined
    })
  );
  app.use(
    compression({
      filter: (req, res) => {
        if (/^\/api\/media\/[^/]+\/stream$/.test(req.path) ||
          /^\/api\/agent\/threads\/[^/]+\/messages\/stream$/.test(req.path)) {
          return false;
        }

        return compression.filter(req, res);
      }
    })
  );
  app.use(express.json({ limit: "12mb" }));
  app.get("/api/demo/status", (_req, res) => res.json({ demo: Boolean(config.demoMode), readOnly: Boolean(config.demoMode), content: config.demoMode ? "non-adult-film-mock" : "user-library" }));
  if (config.demoMode) {
    app.get("/api/health/ping", (_req, res) => res.json({ ok: true, service: "alexandria", demo: true }));
    app.get("/api/agent/capabilities", (_req, res) => res.json({ agentAvailable: false, unavailableReason: "公开 Demo 使用固定示例，不连接模型服务" }));
    app.get("/api/metadata/status", (_req, res) => res.json({ configured: false, running: false }));
    app.use("/api", demoAccess);
    app.get("/api/demo/catalog", (_req, res) => res.json(demoFilmExperience()));
    app.use(demoStaticAccess);
  }
  accessControl.register(app);
  app.use(diagnosticsMiddleware);

  // Reserved local-only module paths must not fall through to static files or the main SPA.
  app.use(["/api/web-library", "/web-library"], (_req, res) => { res.sendStatus(404); });
  registerRoutes(app);

  const clientDist = path.resolve("dist/client");
  app.use(
    express.static(clientDist, {
      setHeaders: (res, filePath) => {
        if (filePath.includes(`${path.sep}assets${path.sep}`)) {
          res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
          return;
        }

        if (filePath.includes(`${path.sep}product-intro${path.sep}generated${path.sep}`)) {
          res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
          return;
        }

        res.setHeader("Cache-Control", "no-cache");
      }
    })
  );
  app.get("*", (_req, res) => {
    res.sendFile(path.join(clientDist, "index.html"));
  });

  app.use(
    (
      error: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction
    ) => {
      const message = error instanceof Error ? error.message : "Unexpected server error";
      const explicitStatus = error && typeof error === "object"
        ? Number((error as { status?: unknown; statusCode?: unknown }).status ??
          (error as { statusCode?: unknown }).statusCode)
        : Number.NaN;
      const status = error instanceof ZodError
        ? 400
        : Number.isInteger(explicitStatus) && explicitStatus >= 400 && explicitStatus <= 599
          ? explicitStatus
          : 500;
      if (status >= 500) console.error(error);
      res.status(status).json({
        error: config.demoMode && status >= 500 ? "Demo 暂时无法处理此请求" : message,
        ...(error instanceof ZodError ? { issues: error.issues } : {})
      });
    }
  );

  return app;
}
