import { afterAll, afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import http from "node:http";
import { createMetadataSourceRuntime } from "../../server/src/metadataSourceRuntime";

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "alexandria-metadata-test-"));
const runtimes: ReturnType<typeof createMetadataSourceRuntime>[] = [];
afterEach(() => { for (const runtime of runtimes.splice(0)) runtime.stop(); });
afterAll(() => fs.rmSync(temporary, { recursive: true, force: true }));
const freePort = () => new Promise<number>((resolve, reject) => {
  const server = net.createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const port = (server.address() as net.AddressInfo).port;
    server.close(() => resolve(port));
  });
});

describe("optional metadata service management", () => {
  it("starts a configured local service, waits until ready, and stops its child", async () => {
    const port = await freePort();
    const command = path.join(temporary, "metadata-service");
    fs.writeFileSync(command, `#!${process.execPath}\nconst http=require('node:http');\nconst args=process.argv;\nhttp.createServer((req,res)=>{res.writeHead(req.url==='/v1/providers'?200:404);res.end('[]')}).listen(Number(args[args.indexOf('-port')+1]),'127.0.0.1');\n`);
    fs.chmodSync(command, 0o700);
    const url = `http://127.0.0.1:${port}`;
    const runtime = createMetadataSourceRuntime({ enabled: true, serverUrl: url, command,
      databasePath: path.join(temporary, "metadata.db"), readyTimeoutMs: 5000 });
    runtimes.push(runtime);
    expect(await runtime.start()).toBe(true);
    expect((await fetch(`${url}/v1/providers`)).status).toBe(200);
    runtime.stop();
    await expect.poll(async () => {
      try { await fetch(`${url}/v1/providers`); return true; } catch { return false; }
    }, { timeout: 3000 }).toBe(false);
  });

  it("never starts a child when disabled or given a remote service URL", async () => {
    const options = { serverUrl: "http://example.test:8080", command: "/nonexistent/service",
      databasePath: path.join(temporary, "db.sqlite"), retryMs: 10 };
    const disabled = createMetadataSourceRuntime({ ...options, enabled: false });
    const remote = createMetadataSourceRuntime({ ...options, enabled: true });
    runtimes.push(disabled, remote);
    expect(await disabled.start()).toBe(false);
    expect(await remote.start()).toBe(false);
  });

  it("reuses an existing service without stopping it", async () => {
    const server = http.createServer((_request, response) => response.end("[]"));
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as net.AddressInfo).port;
    const runtime = createMetadataSourceRuntime({ enabled: true, serverUrl: `http://127.0.0.1:${port}`,
      command: path.join(temporary, "not-needed"), databasePath: path.join(temporary, "existing.db") });
    runtimes.push(runtime);
    try {
      expect(await runtime.start()).toBe(true);
      runtime.stop();
      expect((await fetch(`http://127.0.0.1:${port}/v1/providers`)).status).toBe(200);
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});
