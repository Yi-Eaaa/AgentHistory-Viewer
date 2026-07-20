import http from "node:http";
import { URL } from "node:url";
import { Buffer } from "node:buffer";
import { request as proxyRequest } from "node:http";
import { HistoryStore } from "./history-store.mjs";

const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? 30100);
const uiOrigin = process.env.UI_ORIGIN ?? "http://localhost:30101";
const username = process.env.AGENT_HISTORY_USERNAME ?? "";
const password = process.env.AGENT_HISTORY_PASSWORD ?? "";
const store = new HistoryStore();
await store.init();

function json(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  response.end(body);
}

function authorized(request) {
  if (!username || !password) return true;
  const header = request.headers.authorization ?? "";
  if (!header.startsWith("Basic ")) return false;
  try {
    const [candidateUser, ...rest] = Buffer.from(header.slice(6), "base64").toString("utf8").split(":");
    return candidateUser === username && rest.join(":") === password;
  } catch {
    return false;
  }
}

function proxy(request, response) {
  const target = new URL(request.url ?? "/", uiOrigin);
  const upstream = proxyRequest(
    target,
    { method: request.method, headers: { ...request.headers, host: target.host } },
    (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
      upstreamResponse.pipe(response);
    },
  );
  upstream.on("error", () => {
    response.writeHead(503, { "content-type": "text/html; charset=utf-8" });
    response.end("<h1>页面服务尚未就绪</h1><p>请稍后刷新。</p>");
  });
  request.pipe(upstream);
}

const server = http.createServer(async (request, response) => {
  if (!authorized(request)) {
    response.writeHead(401, { "www-authenticate": 'Basic realm="Agent History"', "content-type": "text/plain; charset=utf-8" });
    response.end("需要登录");
    return;
  }
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  if (!url.pathname.startsWith("/api/")) return proxy(request, response);

  try {
    if (request.method === "GET" && url.pathname === "/api/health") {
      return json(response, 200, { ok: true, service: "agent-history", scannedAt: store.lastScanAt });
    }
    if (request.method === "GET" && url.pathname === "/api/config") {
      return json(response, 200, {
        roots: store.roots,
        authEnabled: Boolean(username && password),
        defaults: { port, host },
      });
    }
    if (request.method === "POST" && url.pathname === "/api/refresh") {
      return json(response, 200, await store.refresh());
    }
    if (request.method === "GET" && url.pathname === "/api/sessions") {
      return json(response, 200, await store.list(Object.fromEntries(url.searchParams)));
    }
    if (request.method === "GET" && url.pathname === "/api/stats") {
      return json(response, 200, await store.stats(Object.fromEntries(url.searchParams)));
    }
    const sessionMatch = url.pathname.match(/^\/api\/sessions\/(codex|claude)\/([^/]+)$/);
    if (request.method === "GET" && sessionMatch) {
      const session = await store.get(sessionMatch[1], decodeURIComponent(sessionMatch[2]));
      return session ? json(response, 200, session) : json(response, 404, { error: "会话不存在" });
    }
    const favoriteMatch = url.pathname.match(/^\/api\/favorites\/(codex|claude)\/([^/]+)$/);
    if (["PUT", "DELETE"].includes(request.method) && favoriteMatch) {
      const enabled = request.method === "PUT";
      const ok = store.setFavorite(favoriteMatch[1], decodeURIComponent(favoriteMatch[2]), enabled);
      return ok ? json(response, 200, { favorite: enabled }) : json(response, 404, { error: "会话不存在" });
    }
    const exportMatch = url.pathname.match(/^\/api\/export\/(codex|claude)\/([^/]+)$/);
    if (request.method === "GET" && exportMatch) {
      const format = url.searchParams.get("format") === "html" ? "html" : "md";
      const exported = await store.export(exportMatch[1], decodeURIComponent(exportMatch[2]), format);
      if (!exported) return json(response, 404, { error: "会话不存在" });
      const safeName = `agent-history-${exportMatch[1]}-${exportMatch[2].slice(0, 12)}.${exported.extension}`;
      response.writeHead(200, {
        "content-type": exported.contentType,
        "content-disposition": `attachment; filename="${safeName}"`,
        "content-length": Buffer.byteLength(exported.body),
      });
      response.end(exported.body);
      return;
    }
    return json(response, 404, { error: "接口不存在" });
  } catch (error) {
    console.error(error);
    return json(response, 500, { error: "服务处理失败", detail: process.env.NODE_ENV === "development" ? String(error) : undefined });
  }
});

server.listen(port, host, () => {
  console.log(`Agent History 已启动：http://${host}:${port}`);
  console.log(`Codex: ${store.roots.codex}`);
  console.log(`Claude Code: ${store.roots.claude}`);
  if (!username || !password) console.log("认证：未启用（默认仅监听本机）");
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
