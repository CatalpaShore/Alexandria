import http, { type IncomingMessage } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildProxyRequestHeaders,
  proxyHttpRequest,
  rewriteProxyLocation
} from "../../server/src/reverseProxy";

const servers: http.Server[] = [];

async function listen(server: http.Server): Promise<number> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected an IPv4 test listener");
  return address.port;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  })));
});

describe("NAS reverse proxy", () => {
  it("preserves the public NAS origin while addressing the private upstream", () => {
    const request = {
      headers: {
        host: "nas.local:5188",
        origin: "https://nas.example.com",
        connection: "keep-alive",
        "x-forwarded-host": "nas.example.com",
        "x-forwarded-proto": "https",
        "x-forwarded-for": "203.0.113.8"
      },
      socket: { remoteAddress: "192.168.50.2" }
    } as IncomingMessage;
    const target = new URL("http://192.168.50.20:5179");

    expect(buildProxyRequestHeaders(request, target)).toMatchObject({
      host: "192.168.50.20:5179",
      origin: "http://192.168.50.20:5179",
      "x-forwarded-host": "nas.example.com",
      "x-forwarded-proto": "https",
      "x-forwarded-for": "203.0.113.8, 192.168.50.2",
      "x-forwarded-origin": "https://nas.example.com"
    });
    expect(buildProxyRequestHeaders(request, target)).not.toHaveProperty("connection");
    expect(rewriteProxyLocation("http://192.168.50.20:5179/library?q=1", target, request))
      .toBe("https://nas.example.com/library?q=1");
    expect(rewriteProxyLocation(
      "http://192.168.50.20:5179/library?q=1",
      target,
      request,
      "https://vendor-proxy.example.net"
    )).toBe("https://vendor-proxy.example.net/library?q=1");
    expect(rewriteProxyLocation("https://example.org/help", target, request)).toBe("https://example.org/help");
  });

  it("streams API and byte-range responses without redirecting the client", async () => {
    const upstreamPort = await listen(http.createServer((request, response) => {
      if (request.url === "/video" && request.headers.range === "bytes=2-5") {
        response.writeHead(206, {
          "Accept-Ranges": "bytes",
          "Content-Range": "bytes 2-5/10",
          "Content-Length": "4"
        });
        response.end("2345");
        return;
      }
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({
        host: request.headers.host,
        forwardedHost: request.headers["x-forwarded-host"],
        forwardedProtocol: request.headers["x-forwarded-proto"]
      }));
    }));
    const target = `http://127.0.0.1:${upstreamPort}`;
    const gatewayPort = await listen(http.createServer((request, response) => {
      proxyHttpRequest(request, response, target);
    }));

    const apiResponse = await fetch(`http://127.0.0.1:${gatewayPort}/api/test`, {
      headers: { "X-Forwarded-Host": "nas.example.com", "X-Forwarded-Proto": "https" }
    });
    await expect(apiResponse.json()).resolves.toMatchObject({
      host: `127.0.0.1:${upstreamPort}`,
      forwardedHost: "nas.example.com",
      forwardedProtocol: "https"
    });

    const rangeResponse = await fetch(`http://127.0.0.1:${gatewayPort}/video`, {
      headers: { Range: "bytes=2-5" }
    });
    expect(rangeResponse.status).toBe(206);
    expect(rangeResponse.headers.get("content-range")).toBe("bytes 2-5/10");
    await expect(rangeResponse.text()).resolves.toBe("2345");
  });
});
