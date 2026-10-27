import os from "node:os";

export type DiscoveredService = {
  url: string;
  healthUrl: string;
  latencyMs: number;
};

type DiscoveryOptions = {
  port?: number;
  timeoutMs?: number;
  concurrency?: number;
  candidates?: string[];
};

function ipv4ToNumber(address: string): number | null {
  const octets = address.split(".").map((value) => Number.parseInt(value, 10));
  if (octets.length !== 4 || octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) {
    return null;
  }
  return (((octets[0] << 24) >>> 0) + (octets[1] << 16) + (octets[2] << 8) + octets[3]) >>> 0;
}

function numberToIpv4(value: number): string {
  return [value >>> 24, (value >>> 16) & 255, (value >>> 8) & 255, value & 255].join(".");
}

export function isPrivateIpv4(address: string): boolean {
  const value = ipv4ToNumber(address);
  if (value === null) return false;
  const first = value >>> 24;
  const second = (value >>> 16) & 255;
  return first === 10
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168);
}

export function buildSubnetCandidates(address: string, port = 5179): string[] {
  const value = ipv4ToNumber(address);
  if (value === null || !isPrivateIpv4(address)) return [];
  const network = value & 0xffffff00;
  const ownHost = value & 255;
  const candidates: string[] = [];
  for (let host = 1; host < 255; host += 1) {
    if (host === ownHost) continue;
    candidates.push(`http://${numberToIpv4((network | host) >>> 0)}:${port}`);
  }
  return candidates;
}

function normalizeCandidate(value: string, port: number): string | null {
  const input = value.trim();
  if (!input) return null;
  try {
    const withProtocol = /^https?:\/\//i.test(input) ? input : `http://${input}`;
    const parsed = new URL(withProtocol);
    if (!parsed.port) parsed.port = String(port);
    parsed.pathname = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

export function getLanCandidateUrls(port = 5179): string[] {
  const explicit = (process.env.DISCOVERY_TARGETS ?? "")
    .split(/[;,]/)
    .map((value) => normalizeCandidate(value, port))
    .filter((value): value is string => Boolean(value));
  const lanAddresses = Object.entries(os.networkInterfaces())
    .filter(([name]) => !/^(lo|docker|br-|veth|utun|awdl|llw|anpi)/i.test(name))
    .flatMap(([, addresses]) => addresses ?? [])
    .filter((address) => address.family === "IPv4" && !address.internal && isPrivateIpv4(address.address))
    .map((address) => address.address);
  const self = lanAddresses.map((address) => `http://${address}:${port}`);
  const local = lanAddresses
    .flatMap((address) => buildSubnetCandidates(address, port));
  return [...new Set([...explicit, ...self, ...local])];
}

async function probeService(url: string, timeoutMs: number): Promise<DiscoveredService | null> {
  const startedAt = performance.now();
  for (const path of ["/api/access/status", "/api/health/ping", "/api/health"]) {
    const healthUrl = `${url}${path}`;
    try {
      const response = await fetch(healthUrl, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(timeoutMs)
      });
      if (!response.ok) continue;
      const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
      if (!contentType.includes("application/json")) continue;
      const health = await response.json() as {
        ok?: unknown;
        mode?: unknown;
        requiresAuthentication?: unknown;
        authenticated?: unknown;
      };
      const isAccessStatus = path === "/api/access/status"
        && (health.mode === "local-only" || health.mode === "lan-open" || health.mode === "lan-protected")
        && typeof health.requiresAuthentication === "boolean"
        && typeof health.authenticated === "boolean";
      if (!isAccessStatus && health.ok !== true) continue;
      return { url, healthUrl, latencyMs: Math.round(performance.now() - startedAt) };
    } catch {
      // Fall back to legacy health endpoints for older deployments.
    }
  }
  return null;
}

export async function discoverLanService(options: DiscoveryOptions = {}): Promise<{
  service: DiscoveredService | null;
  candidateCount: number;
  elapsedMs: number;
}> {
  const port = options.port ?? 5179;
  const timeoutMs = options.timeoutMs ?? 450;
  const concurrency = Math.max(1, Math.min(64, options.concurrency ?? 32));
  const candidates = options.candidates ?? getLanCandidateUrls(port);
  const startedAt = performance.now();
  let cursor = 0;
  let service: DiscoveredService | null = null;

  const worker = async () => {
    while (!service) {
      const index = cursor;
      cursor += 1;
      if (index >= candidates.length) return;
      const result = await probeService(candidates[index], timeoutMs);
      if (result && !service) service = result;
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, candidates.length) }, () => worker()));
  return {
    service,
    candidateCount: candidates.length,
    elapsedMs: Math.round(performance.now() - startedAt)
  };
}
