import fs from "node:fs";
import path from "node:path";
import type { Request, Response } from "express";
import { getMediaSources } from "../config.js";
import type { MediaRow } from "../db.js";
import { markResponseReady } from "../requestTiming.js";

const STREAM_HIGH_WATER_MARK = 1024 * 1024;

export function ensureInsideMediaRoot(filePath: string): void {
  const inside = getMediaSources().some((source) => {
    let root: string;
    let resolved: string;
    try { root = fs.realpathSync(source.root); resolved = fs.realpathSync(filePath); } catch { return false; }
    const relative = path.relative(root, resolved);
    return relative && !relative.startsWith("..") && !path.isAbsolute(relative);
  });
  if (!inside) throw new Error("Resolved file is outside configured media sources");
}

function pipeStream(
  stream: fs.ReadStream,
  req: Request | null,
  res: Response,
  errorStatus: 404 | 500
): void {
  const destroyStream = () => stream.destroy();
  const cleanup = () => {
    req?.off("aborted", destroyStream);
    res.off("close", destroyStream);
    res.off("finish", cleanup);
  };

  req?.once("aborted", destroyStream);
  res.once("close", destroyStream);
  res.once("finish", cleanup);
  stream.once("error", (error) => {
    cleanup();
    if (res.headersSent) {
      res.destroy(error);
      return;
    }
    res.status(errorStatus).end();
  });
  stream.once("close", cleanup);
  markResponseReady(res);
  res.flushHeaders();
  stream.pipe(res);
}

export function pipeFileStream(stream: fs.ReadStream, res: Response): void {
  pipeStream(stream, null, res, 500);
}

export function streamFile(
  filePath: string,
  mimeType: string,
  req: Request,
  res: Response,
  options: { cacheControl?: string } = {}
): void {
  const stat = fs.statSync(filePath);
  const range = req.headers.range;
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Content-Type", mimeType);
  res.setHeader("Cache-Control", options.cacheControl ?? "private, max-age=86400, no-transform");
  res.setHeader("X-Accel-Buffering", "no");

  if (!range) {
    res.setHeader("Content-Length", stat.size);
    if (req.method === "HEAD") return void res.end();
    pipeStream(fs.createReadStream(filePath, { highWaterMark: STREAM_HIGH_WATER_MARK }), req, res, 500);
    return;
  }

  const match = /^bytes=(\d*)-(\d*)$/i.exec(range.trim());
  if (!match || (!match[1] && !match[2])) {
    res.status(416).setHeader("Content-Range", `bytes */${stat.size}`).end();
    return;
  }
  let start = Number.parseInt(match[1], 10);
  let end = match[2] ? Number.parseInt(match[2], 10) : stat.size - 1;
  if (Number.isNaN(start)) {
    if (end <= 0) {
      res.status(416).setHeader("Content-Range", `bytes */${stat.size}`).end();
      return;
    }
    start = Math.max(0, stat.size - end);
    end = stat.size - 1;
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= stat.size) {
    res.status(416).setHeader("Content-Range", `bytes */${stat.size}`).end();
    return;
  }
  end = Math.min(end, stat.size - 1);
  res.status(206);
  res.setHeader("Content-Range", `bytes ${start}-${end}/${stat.size}`);
  res.setHeader("Content-Length", end - start + 1);
  if (req.method === "HEAD") return void res.end();
  pipeStream(fs.createReadStream(filePath, { start, end, highWaterMark: STREAM_HIGH_WATER_MARK }), req, res, 500);
}

export function streamMedia(media: MediaRow, req: Request, res: Response): void {
  ensureInsideMediaRoot(media.absolute_path);

  const size = Number.isSafeInteger(media.size) && media.size >= 0
    ? media.size
    : fs.statSync(media.absolute_path).size;
  const range = req.headers.range;
  const etag = `W/"${size.toString(16)}-${Math.trunc(media.mtime_ms).toString(16)}"`;

  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Content-Type", media.mime_type);
  res.setHeader("Cache-Control", "private, max-age=86400, no-transform");
  res.setHeader("Content-Disposition", "inline");
  res.setHeader("ETag", etag);
  res.setHeader("Last-Modified", new Date(media.mtime_ms).toUTCString());
  res.setHeader("X-Accel-Buffering", "no");

  const pipeMedia = (options?: { start: number; end: number }) => {
    pipeStream(
      fs.createReadStream(media.absolute_path, { ...options, highWaterMark: STREAM_HIGH_WATER_MARK }),
      req,
      res,
      404
    );
  };

  if (!range) {
    if (req.headers["if-none-match"] === etag) {
      res.status(304).end();
      return;
    }
    res.setHeader("Content-Length", size);
    if (req.method === "HEAD") return void res.end();
    pipeMedia();
    return;
  }

  const match = /^bytes=(\d*)-(\d*)$/i.exec(range.trim());
  if (!match || (!match[1] && !match[2])) {
    res.status(416).setHeader("Content-Range", `bytes */${size}`).end();
    return;
  }
  const [, startText, endText] = match;
  let start = Number.parseInt(startText, 10);
  let end = endText ? Number.parseInt(endText, 10) : size - 1;
  if (Number.isNaN(start) && !Number.isNaN(end)) {
    if (end <= 0) {
      res.status(416).setHeader("Content-Range", `bytes */${size}`).end();
      return;
    }
    start = Math.max(size - end, 0);
    end = size - 1;
  }
  if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= size) {
    res.status(416).setHeader("Content-Range", `bytes */${size}`).end();
    return;
  }
  end = Math.min(end, size - 1);
  res.status(206);
  res.setHeader("Content-Range", `bytes ${start}-${end}/${size}`);
  res.setHeader("Content-Length", end - start + 1);
  if (req.method === "HEAD") return void res.end();
  pipeMedia({ start, end });
}
