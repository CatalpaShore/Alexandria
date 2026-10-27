import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { buildSubnetCandidates, discoverLanService, isPrivateIpv4 } from "../../server/src/serviceDiscovery";

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

describe("LAN service discovery", () => {
  it("only accepts RFC1918 IPv4 addresses", () => {
    expect(isPrivateIpv4("192.168.50.20")).toBe(true);
    expect(isPrivateIpv4("172.20.0.3")).toBe(true);
    expect(isPrivateIpv4("10.0.0.2")).toBe(true);
    expect(isPrivateIpv4("8.8.8.8")).toBe(false);
  });

  it("builds a bounded /24 scan and excludes the current host", () => {
    const candidates = buildSubnetCandidates("192.168.50.20", 5179);
    expect(candidates).toHaveLength(253);
    expect(candidates).toContain("http://192.168.50.1:5179");
    expect(candidates).not.toContain("http://192.168.50.20:5179");
    expect(candidates).not.toContain("http://192.168.50.255:5179");
  });

  it("returns an empty result without probing when no candidates exist", async () => {
    await expect(discoverLanService({ candidates: [] })).resolves.toMatchObject({
      service: null,
      candidateCount: 0
    });
  });

  it("discovers a LAN-protected service without requiring an authenticated health request", async () => {
    const port = await listen(http.createServer((request, response) => {
      response.setHeader("Content-Type", "application/json");
      if (request.url === "/api/access/status") {
        response.end(JSON.stringify({
          mode: "lan-protected",
          requiresAuthentication: true,
          authenticated: false
        }));
        return;
      }
      response.writeHead(401);
      response.end(JSON.stringify({ code: "AMW_AUTH_REQUIRED" }));
    }));
    const target = `http://127.0.0.1:${port}`;

    await expect(discoverLanService({ candidates: [target], timeoutMs: 500, concurrency: 1 }))
      .resolves.toMatchObject({
        service: {
          url: target,
          healthUrl: `${target}/api/access/status`
        },
        candidateCount: 1
      });
  });

  it("discovers the direct-access LAN mode", async () => {
    const port = await listen(http.createServer((_request, response) => {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({
        mode: "lan-open",
        requiresAuthentication: false,
        authenticated: true
      }));
    }));
    const target = `http://127.0.0.1:${port}`;

    await expect(discoverLanService({ candidates: [target], timeoutMs: 500, concurrency: 1 }))
      .resolves.toMatchObject({ service: { url: target } });
  });

  it("keeps the legacy health fallback for older services", async () => {
    const port = await listen(http.createServer((request, response) => {
      response.setHeader("Content-Type", "application/json");
      if (request.url === "/api/health/ping") {
        response.end(JSON.stringify({ ok: true, service: "alexandria" }));
        return;
      }
      response.writeHead(404);
      response.end(JSON.stringify({ error: "not found" }));
    }));
    const target = `http://127.0.0.1:${port}`;

    await expect(discoverLanService({ candidates: [target], timeoutMs: 500, concurrency: 1 }))
      .resolves.toMatchObject({
        service: {
          url: target,
          healthUrl: `${target}/api/health/ping`
        }
      });
  });
});
