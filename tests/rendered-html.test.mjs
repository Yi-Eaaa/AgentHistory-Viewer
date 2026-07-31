import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(
    new Request("http://localhost/", { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("server renders the AgentHistory Viewer application shell", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  const html = await response.text();
  assert.match(html, /<title>AgentHistory Viewer<\/title>/i);
  assert.match(html, /AgentHistory Viewer/);
  assert.match(html, /favicon\.png/);
  assert.doesNotMatch(html, /LOCAL ARCHIVE|本机只读|历史数据不会上传/);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape|react-loading-skeleton/i);
});

test("conversation timeline has a bounded, independently scrollable height chain", async () => {
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.match(css, /\.app-shell\s*\{[^}]*height:\s*100dvh[^}]*display:\s*flex[^}]*overflow:\s*hidden/s);
  assert.match(css, /\.workspace\s*\{[^}]*min-height:\s*0[^}]*grid-template-rows:\s*minmax\(0,\s*1fr\)/s);
  assert.match(css, /\.conversation\s*\{[^}]*min-height:\s*0[^}]*overflow:\s*hidden[^}]*display:\s*flex/s);
  assert.match(css, /\.message-scroll\s*\{[^}]*min-height:\s*0[^}]*overflow-y:\s*auto[^}]*touch-action:\s*pan-y/s);
});

test("sidebar separates source, favorites and workspace filters", async () => {
  const source = await readFile(new URL("../app/history-app.tsx", import.meta.url), "utf8");
  for (const label of ["来源筛选", "工作区筛选", "仅显示收藏", "所有工作区"]) {
    assert.match(source, new RegExp(label));
  }
  assert.match(source, /sourceTotals\.all/);
  assert.match(source, /payload\.facets\.workspaces/);
  assert.doesNotMatch(source, /projects\.slice\(0, 12\)/);
  assert.ok(source.indexOf('className="favorite-section"') > source.indexOf('className="workspace-section"'));
  assert.match(source, /className="favorite-switch" role="switch" aria-checked=\{favoritesOnly\}/);
  assert.match(source, /function toggleFavoritesOnly\(\)/);
  assert.match(source, /!favoritesOnly \|\| sourceTotals\.codex > 0/);
  assert.match(source, /!favoritesOnly \|\| sourceTotals\.claude > 0/);
});

test("conversation header exposes complete session identity metadata", async () => {
  const source = await readFile(new URL("../app/history-app.tsx", import.meta.url), "utf8");
  for (const label of ["工作区", "创建时间", "更新时间"]) {
    assert.match(source, new RegExp(`>${label}<`));
  }
  assert.match(source, /session\.cwd \|\| session\.project/);
  assert.match(source, /formatTimestamp\(session\.startedAt\)/);
  assert.match(source, /formatTimestamp\(session\.updatedAt\)/);
  assert.match(source, /session\.toolCount[^\n]*次工具调用<\/span><span className="session-id-fact"[^\n]*>session_id: \{session\.id\}<\/span>/);
});

test("subagent sessions use a distinct collapsible visual treatment", async () => {
  const [source, css] = await Promise.all([
    readFile(new URL("../app/history-app.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);
  assert.match(source, /function SubagentSessionCard/);
  assert.match(source, /const \[open, setOpen\] = useState\(false\)/);
  assert.match(source, /subagent\.label/);
  assert.match(css, /--violet:/);
  assert.match(css, /\.subagent-card\s*\{[^}]*var\(--violet\)/s);
});

test("conversation messages render safe GitHub-flavored Markdown while tool logs stay literal", async () => {
  const [source, css, packageJson] = await Promise.all([
    readFile(new URL("../app/history-app.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);
  assert.match(source, /import ReactMarkdown from "react-markdown"/);
  assert.match(source, /import remarkGfm from "remark-gfm"/);
  assert.match(source, /function MarkdownContent/);
  assert.ok((source.match(/<MarkdownContent text=\{message\.text\}/g) ?? []).length >= 4);
  assert.match(source, /target=\{external \? "_blank" : undefined\}/);
  assert.doesNotMatch(source, /dangerouslySetInnerHTML/);
  assert.match(source, /<pre>\{message\.text \|\| "无"\}<\/pre>/);
  assert.match(source, /<pre>\{message\.result \|\| "（空结果）"\}<\/pre>/);
  assert.match(css, /\.markdown-body blockquote/);
  assert.match(css, /\.markdown-body pre code/);
  assert.match(css, /\.markdown-body table/);
  assert.match(css, /\.markdown-body ul:not\(\.contains-task-list\)\s*\{[^}]*list-style:\s*disc/s);
  assert.match(css, /\.markdown-body ol\s*\{[^}]*list-style:\s*decimal/s);
  assert.match(packageJson, /"react-markdown"/);
  assert.match(packageJson, /"remark-gfm"/);
});

test("model statistics visualize token usage relative to the busiest model", async () => {
  const [source, css] = await Promise.all([
    readFile(new URL("../app/history-app.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);
  assert.match(source, /maxModelTokens/);
  assert.match(source, /role="progressbar"/);
  assert.match(source, /item\.tokens \/ maxModelTokens/);
  assert.match(source, /按 Token 用量排序/);
  assert.ok(source.indexOf('className="model-token-bar"') > source.indexOf('className="model-name"'));
  assert.match(css, /\.model-token-bar/);
  assert.match(css, /grid-template-columns:\s*clamp\(100px, 28%, 132px\) minmax\(70px, 1fr\)/);
});

test("one refresh action reloads the selected session without losing the timeline position", async () => {
  const source = await readFile(new URL("../app/history-app.tsx", import.meta.url), "utf8");
  assert.equal(source.match(/void refresh\(\)/g)?.length, 1);
  assert.match(source, /getJson\("\/api\/refresh", \{ method: "POST" \}\)/);
  assert.match(source, /const refreshedSession = await getJson<Session>/);
  assert.match(source, /pendingScrollRestoreRef/);
  assert.match(source, /const savedScrollTop = scrollTarget\?\.scrollTop \?\? null/);
  assert.match(source, /target\.scrollTop = Math\.min\(savedScrollTop,/);
  assert.doesNotMatch(source, /stickToBottom/);
  assert.match(source, /ref=\{messageScrollRef\}/);
  assert.match(source, /刷新历史和当前会话/);
});

test("conversation exposes fixed top and bottom jump controls", async () => {
  const [source, css] = await Promise.all([
    readFile(new URL("../app/history-app.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);
  assert.match(source, /className="timeline-jump"/);
  assert.match(source, /jumpTimeline\("top"\)/);
  assert.match(source, /jumpTimeline\("bottom"\)/);
  assert.match(source, /function fastScrollTimeline/);
  assert.match(source, /Math\.min\(180, Math\.max\(90,/);
  assert.match(source, /function jumpToMessage/);
  assert.match(source, /event\.preventDefault\(\); jumpToMessage\(item\.id\)/);
  assert.match(css, /\.timeline-jump\s*\{[^}]*position:\s*absolute/s);
  assert.match(css, /\.message-scroll\s*\{[^}]*scroll-behavior:\s*auto/s);
});

test("only the outline list scrolls while token totals stay fixed", async () => {
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.match(css, /\.outline\s*\{[^}]*grid-template-rows:\s*auto minmax\(0, 1fr\) auto[^}]*overflow:\s*hidden/s);
  assert.match(css, /\.outline nav\s*\{[^}]*min-height:\s*0[^}]*overflow-y:\s*auto/s);
  assert.match(css, /\.token-breakdown\s*\{[^}]*margin-top:\s*0/s);
});

test("primary scrollbars stay quiet and appear only during scroll activity", async () => {
  const [source, css] = await Promise.all([
    readFile(new URL("../app/history-app.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);
  assert.match(source, /onScrollCapture=\{showScrollbarWhileScrolling\}/);
  assert.match(source, /classList\.add\("is-scrolling"\)/);
  assert.match(source, /classList\.remove\("is-scrolling"\)/);
  assert.match(css, /scrollbar-color:\s*transparent transparent/);
  assert.match(css, /\.is-scrolling[^}]*scrollbar-color:/s);
  assert.match(css, /::-webkit-scrollbar\s*\{[^}]*width:\s*5px/s);
});

test("tool, subagent and timeline end blocks share the centered message frame", async () => {
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.match(css, /\.message-scroll\s*\{[^}]*--timeline-width:\s*850px[^}]*--timeline-rail-offset:\s*44px/s);
  assert.match(css, /\.tool-card, \.reasoning-card\s*\{[^}]*width:\s*calc\(100% - var\(--timeline-rail-offset\)\)[^}]*max-width:\s*calc\(var\(--timeline-width\) - var\(--timeline-rail-offset\)\)[^}]*margin:[^}]*max\(var\(--timeline-rail-offset\)/s);
  assert.match(css, /\.tool-group\s*\{[^}]*max\(var\(--timeline-rail-offset\)/s);
  assert.match(css, /\.subagent-card\s*\{[^}]*max\(var\(--timeline-rail-offset\)/s);
  assert.match(css, /\.timeline-end\s*\{[^}]*width:\s*min\(100%, var\(--timeline-width\)\)[^}]*justify-content:\s*center/s);
  assert.doesNotMatch(css, /margin:\s*0 auto (?:18|20)px 44px/);
});

test("portable session import and export expose preflight, workspace mapping and overwrite confirmation", async () => {
  const [source, css, server] = await Promise.all([
    readFile(new URL("../app/history-app.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../server/index.mjs", import.meta.url), "utf8"),
  ]);
  assert.match(source, /\/api\/portable\/export\/\$\{session\.source\}/);
  assert.match(source, />导出会话<\/a>/);
  assert.match(source, /\/api\/portable\/inspect/);
  assert.match(source, /\/api\/portable\/import\?\$\{params\}/);
  assert.match(source, /JSON\.stringify\(\{ importToken: importPreview\.importToken \}\)/);
  assert.match(source, /void loadSessions\(importedKey\)/);
  assert.match(source, /保持原工作区/);
  assert.match(source, /映射到新工作区/);
  assert.match(source, /overwriteArmed/);
  assert.match(source, /确认覆盖并导入/);
  assert.match(source, /旧文件会先备份到 state\/import-backups/);
  assert.match(css, /\.import-dialog/);
  assert.match(css, /\.import-warning\.danger/);
  assert.match(server, /\/api\/portable\/inspect/);
  assert.match(server, /\/api\/portable\/import/);
  assert.match(server, /store\.preparePortable\(body\)/);
  assert.match(server, /store\.importPreparedPortable\(payload\?\.importToken, options\)/);
  assert.match(server, /AGENT_HISTORY_IMPORT_MAX_BYTES/);
});
