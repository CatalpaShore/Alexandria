import http from "node:http";
import { discoverLanService } from "./serviceDiscovery.js";
import { proxyHttpRequest, proxyWebSocketUpgrade } from "./reverseProxy.js";

const port = Number.parseInt(process.env.PORT ?? "5188", 10) || 5188;
const discoveryPort = Number.parseInt(process.env.DISCOVERY_PORT ?? "5179", 10) || 5179;
const cacheTtlMs = Number.parseInt(process.env.DISCOVERY_CACHE_TTL_MS ?? "10000", 10) || 10_000;
const publicOrigin = process.env.WEBVIEW_PUBLIC_ORIGIN?.trim() ?? "";

let cachedDiscovery: Awaited<ReturnType<typeof discoverLanService>> | null = null;
let cacheExpiresAt = 0;
let pendingDiscovery: Promise<Awaited<ReturnType<typeof discoverLanService>>> | null = null;

async function readDiscovery(force = false) {
  if (!force && cachedDiscovery && Date.now() < cacheExpiresAt) return cachedDiscovery;
  if (pendingDiscovery) return pendingDiscovery;
  pendingDiscovery = discoverLanService({ port: discoveryPort })
    .then((result) => {
      cachedDiscovery = result;
      cacheExpiresAt = Date.now() + cacheTtlMs;
      return result;
    })
    .finally(() => {
      pendingDiscovery = null;
    });
  return pendingDiscovery;
}

function invalidateDiscovery() {
  cachedDiscovery = null;
  cacheExpiresAt = 0;
}

const html = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover" />
  <meta name="theme-color" content="#090909" />
  <title>Alexandria 18+ · NAS 代理网关</title>
  <style>
    *{box-sizing:border-box}body{margin:0;min-height:100dvh;display:grid;place-items:center;background:radial-gradient(circle at 50% 0,#2b1b05 0,#0d0d0d 42%,#070707 100%);color:#f4f1ea;font:15px/1.6 system-ui,-apple-system,sans-serif;padding:24px}.card{width:min(440px,100%);padding:30px;border:1px solid #4d3411;border-radius:24px;background:rgba(17,17,17,.94);box-shadow:0 28px 80px #0009}.mark{width:54px;height:54px;display:grid;place-items:center;border-radius:16px;background:#ff9f0a;color:#111;font-size:28px;font-weight:900}h1{margin:22px 0 4px;font-size:26px}p{margin:0;color:#aaa}.status{margin:24px 0;padding:16px;border-radius:14px;background:#1d1d1d;color:#ddd}.dot{display:inline-block;width:9px;height:9px;margin-right:9px;border-radius:50%;background:#ff9f0a;box-shadow:0 0 18px #ff9f0a;animation:pulse 1s infinite alternate}button{width:100%;border:0;border-radius:13px;padding:13px;background:#ff9f0a;color:#111;font-weight:800;font-size:15px;cursor:pointer}small{display:block;margin-top:18px;color:#777}@keyframes pulse{to{opacity:.3}}
  </style>
</head>
<body><main class="card"><div class="mark">A</div><h1>Alexandria 18+</h1><p>NAS 正在连接内部媒体服务</p><div class="status"><span class="dot"></span><span id="status">扫描 ${discoveryPort} 端口…</span></div><button id="retry" hidden>重新扫描</button><small>连接成功后由 NAS 持续转发页面、API 与视频流，浏览器不会跳转到内部地址。</small></main>
<script>
const status=document.querySelector('#status');const retry=document.querySelector('#retry');
async function discover(force=false){retry.hidden=true;status.textContent='扫描 ${discoveryPort} 端口…';
try{const response=await fetch('/__gateway/discovery'+(force?'?refresh=1':''),{cache:'no-store'});const data=await response.json();
if(data.service){status.textContent='内部服务已连接，正在通过 NAS 进入…';setTimeout(()=>location.replace('/'),250);return;}
status.textContent='未发现可用服务，请确认前后端已经启动。';retry.hidden=false;
}catch(error){status.textContent='扫描失败，请稍后重试。';retry.hidden=false;}}
retry.addEventListener('click',()=>discover(true));discover();
</script></body></html>`;

const server = http.createServer(async (request, response) => {
  const requestUrl = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  if (requestUrl.pathname === "/__gateway/health" || requestUrl.pathname === "/__gateway/health/ping") {
    response.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    response.end(JSON.stringify({
      ok: true,
      role: "alexandria-reverse-proxy-gateway",
      discoveryPort,
      upstream: cachedDiscovery?.service?.url ?? null
    }));
    return;
  }
  if (requestUrl.pathname === "/__gateway/discovery" || requestUrl.pathname === "/api/discovery") {
    const result = await readDiscovery(requestUrl.searchParams.get("refresh") === "1");
    response.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    response.end(JSON.stringify(result));
    return;
  }

  const discovery = await readDiscovery();
  if (discovery.service) {
    proxyHttpRequest(request, response, discovery.service.url, invalidateDiscovery, publicOrigin);
    return;
  }

  const acceptsHtml = request.headers.accept?.includes("text/html");
  if (requestUrl.pathname === "/" || requestUrl.pathname === "/index.html" || acceptsHtml) {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    response.end(html);
    return;
  }
  response.writeHead(503, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify({ error: "No Alexandria 18+ upstream service was discovered" }));
});

server.on("upgrade", async (request, socket, head) => {
  const discovery = await readDiscovery();
  if (!discovery.service) {
    socket.write("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  proxyWebSocketUpgrade(request, socket, head, discovery.service.url, invalidateDiscovery, publicOrigin);
});

server.listen(port, "0.0.0.0", () => {
  console.log(`Alexandria 18+ NAS reverse proxy listening on http://0.0.0.0:${port}`);
  console.log(`Discovering private upstream services on port ${discoveryPort}`);
  console.log("Client requests remain on the NAS gateway origin");
  if (publicOrigin) console.log(`Using configured public origin ${publicOrigin}`);
});
