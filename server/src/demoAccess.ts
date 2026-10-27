import type { RequestHandler } from "express";
import path from "node:path";

const browsable = [
  /^\/demo\/catalog$/,
  /^\/(?:media|search|topics|entities|library-analytics|viewing-desk|recommendations|knowledge-graph)(?:\/|$)/,
  /^\/(?:sidecars|playlists|highlights)(?:\/|$)/,
  /^\/(?:favorites(?:\/topics\/[^/]+)?|personal-dashboard|saved-filters|users|runtime-capabilities)$/,
  /^\/(?:metadata\/status|notifications\/unread-count|access\/status|health(?:\/summary)?)$/
];

export function redactDemoPaths(value: unknown, root = process.cwd()): unknown {
  if (typeof value === "string") return value.split(root).join("/demo");
  if (Array.isArray(value)) return value.map(item => redactDemoPaths(item, root));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactDemoPaths(item, root)]));
  return value;
}

export const demoAccess: RequestHandler = (req, res, next) => {
  res.setHeader("X-Alexandria-Demo", "read-only");
  res.setHeader("Cache-Control", "no-store");
  const json = res.json.bind(res);
  res.json = body => json(redactDemoPaths(body));
  if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
    res.status(403).json({ code: "DEMO_READ_ONLY", error: "公开 Demo 为只读展示，收藏、播放进度和管理操作不会保存。请自行部署体验完整功能。" });
    return;
  }
  if (browsable.some(pattern => pattern.test(req.path))) { next(); return; }
  res.status(403).json({ code: "DEMO_ADMIN_DISABLED", error: "公开 Demo 不开放本机配置、文件管理、导出或模型服务。" });
};

/** Keep the separately reviewed adult-library recording out of non-adult demos. */
export const demoStaticAccess: RequestHandler = (req, res, next) => {
  let pathname: string;
  try { pathname = path.posix.normalize("/" + decodeURIComponent(req.path).replace(/\\/g, "/")).toLowerCase(); }
  catch { res.sendStatus(400); return; }
  if (pathname === "/tour" || pathname.startsWith("/tour/")) {
    res.setHeader("Cache-Control", "no-store");
    res.sendStatus(404);
    return;
  }
  next();
};
