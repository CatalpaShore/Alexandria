import http, { type IncomingHttpHeaders, type IncomingMessage, type OutgoingHttpHeaders, type ServerResponse } from "node:http";
import https from "node:https";
import type { Duplex } from "node:stream";

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade"
]);

function firstHeader(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0]?.trim() ?? "";
  return value?.split(",")[0]?.trim() ?? "";
}

function connectionHeaderNames(headers: IncomingHttpHeaders): string[] {
  const value = firstHeader(headers.connection);
  return value.split(",").map((item) => item.trim().toLowerCase()).filter(Boolean);
}

function publicRequestOrigin(request: IncomingMessage, publicOriginOverride = ""): string {
  if (publicOriginOverride) {
    try {
      return new URL(publicOriginOverride).origin;
    } catch {
      // Ignore an invalid optional override and use forwarded request headers.
    }
  }
  const forwardedProtocol = firstHeader(request.headers["x-forwarded-proto"]);
  const protocol = forwardedProtocol === "https" ? "https" : "http";
  const host = firstHeader(request.headers["x-forwarded-host"]) || firstHeader(request.headers.host);
  return host ? `${protocol}://${host}` : "";
}

export function buildProxyRequestHeaders(
  request: IncomingMessage,
  target: URL,
  websocket = false,
  publicOriginOverride = ""
): OutgoingHttpHeaders {
  const headers: OutgoingHttpHeaders = { ...request.headers };
  const connectionHeaders = new Set(connectionHeaderNames(request.headers));
  for (const key of Object.keys(headers)) {
    if (HOP_BY_HOP_HEADERS.has(key.toLowerCase()) || connectionHeaders.has(key.toLowerCase())) delete headers[key];
  }

  const publicOrigin = publicRequestOrigin(request, publicOriginOverride);
  const parsedPublicOrigin = publicOrigin ? new URL(publicOrigin) : null;
  const forwardedHost = parsedPublicOrigin?.host
    || firstHeader(request.headers["x-forwarded-host"])
    || firstHeader(request.headers.host);
  const forwardedProtocol = parsedPublicOrigin?.protocol.replace(":", "")
    || firstHeader(request.headers["x-forwarded-proto"])
    || "http";
  const remoteAddress = request.socket.remoteAddress ?? "";
  const existingForwardedFor = firstHeader(request.headers["x-forwarded-for"]);

  headers.host = target.host;
  if (forwardedHost) headers["x-forwarded-host"] = forwardedHost;
  headers["x-forwarded-proto"] = forwardedProtocol;
  if (remoteAddress) headers["x-forwarded-for"] = existingForwardedFor
    ? `${existingForwardedFor}, ${remoteAddress}`
    : remoteAddress;

  if (request.headers.origin) {
    headers["x-forwarded-origin"] = firstHeader(request.headers.origin);
    headers.origin = target.origin;
  }

  if (websocket) {
    headers.connection = "Upgrade";
    headers.upgrade = firstHeader(request.headers.upgrade) || "websocket";
  }
  return headers;
}

export function rewriteProxyLocation(
  location: string | undefined,
  target: URL,
  request: IncomingMessage,
  publicOriginOverride = ""
): string | undefined {
  if (!location) return undefined;
  try {
    const resolved = new URL(location, target);
    if (resolved.origin !== target.origin) return location;
    const publicOrigin = publicRequestOrigin(request, publicOriginOverride);
    if (!publicOrigin) return `${resolved.pathname}${resolved.search}${resolved.hash}`;
    return `${publicOrigin}${resolved.pathname}${resolved.search}${resolved.hash}`;
  } catch {
    return location;
  }
}

function buildProxyResponseHeaders(
  headers: IncomingHttpHeaders,
  target: URL,
  request: IncomingMessage,
  publicOriginOverride = ""
): OutgoingHttpHeaders {
  const forwarded: OutgoingHttpHeaders = { ...headers };
  for (const key of Object.keys(forwarded)) {
    if (HOP_BY_HOP_HEADERS.has(key.toLowerCase())) delete forwarded[key];
  }
  const location = firstHeader(headers.location);
  if (location) forwarded.location = rewriteProxyLocation(location, target, request, publicOriginOverride);
  return forwarded;
}

function transportFor(target: URL) {
  return target.protocol === "https:" ? https : http;
}

function upstreamRequestOptions(
  request: IncomingMessage,
  target: URL,
  websocket = false,
  publicOriginOverride = ""
): http.RequestOptions {
  return {
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port || (target.protocol === "https:" ? 443 : 80),
    method: request.method,
    path: request.url || "/",
    headers: buildProxyRequestHeaders(request, target, websocket, publicOriginOverride)
  };
}

export function proxyHttpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  targetUrl: string,
  onUpstreamError?: (error: Error) => void,
  publicOriginOverride = ""
): void {
  const target = new URL(targetUrl);
  const proxyRequest = transportFor(target).request(
    upstreamRequestOptions(request, target, false, publicOriginOverride),
    (proxyResponse) => {
    response.writeHead(
      proxyResponse.statusCode ?? 502,
      proxyResponse.statusMessage,
      buildProxyResponseHeaders(proxyResponse.headers, target, request, publicOriginOverride)
    );
    proxyResponse.pipe(response);
    }
  );

  proxyRequest.on("error", (error) => {
    onUpstreamError?.(error);
    if (response.headersSent) {
      response.destroy(error);
      return;
    }
    response.writeHead(502, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    response.end(JSON.stringify({ error: "Upstream Alexandria 18+ service is unavailable" }));
  });
  request.on("aborted", () => proxyRequest.destroy());
  request.pipe(proxyRequest);
}

function writeRawResponseHead(socket: Duplex, response: IncomingMessage): void {
  const statusCode = response.statusCode ?? 502;
  const statusMessage = response.statusMessage || http.STATUS_CODES[statusCode] || "Unknown";
  const lines = [`HTTP/1.1 ${statusCode} ${statusMessage}`];
  for (let index = 0; index < response.rawHeaders.length; index += 2) {
    lines.push(`${response.rawHeaders[index]}: ${response.rawHeaders[index + 1]}`);
  }
  socket.write(`${lines.join("\r\n")}\r\n\r\n`);
}

export function proxyWebSocketUpgrade(
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  targetUrl: string,
  onUpstreamError?: (error: Error) => void,
  publicOriginOverride = ""
): void {
  const target = new URL(targetUrl);
  const proxyRequest = transportFor(target).request(
    upstreamRequestOptions(request, target, true, publicOriginOverride)
  );

  proxyRequest.on("upgrade", (proxyResponse, proxySocket, proxyHead) => {
    writeRawResponseHead(socket, proxyResponse);
    if (proxyHead.length) socket.write(proxyHead);
    if (head.length) proxySocket.write(head);
    proxySocket.pipe(socket);
    socket.pipe(proxySocket);
  });
  proxyRequest.on("response", (proxyResponse) => {
    writeRawResponseHead(socket, proxyResponse);
    proxyResponse.pipe(socket);
  });
  proxyRequest.on("error", (error) => {
    onUpstreamError?.(error);
    if (!socket.destroyed) {
      socket.write("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
      socket.destroy();
    }
  });
  proxyRequest.end();
}
