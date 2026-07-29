import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os, { tmpdir } from "node:os";
import path from "node:path";
import { HistoryStore, resolveHistoryRoot } from "../server/history-store.mjs";

test("HistoryStore scans, searches, favorites and exports", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-history-store-"));
  const codexRoot = path.join(root, "codex");
  const claudeRoot = path.join(root, "claude");
  await mkdir(codexRoot);
  await mkdir(claudeRoot);
  const id = "11111111-2222-4333-8444-555555555555";
  const childId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const rows = [
    { type: "session_meta", timestamp: "2026-07-01T01:00:00Z", payload: { id, cwd: "/work/search-demo" } },
    { type: "turn_context", timestamp: "2026-07-01T01:00:00Z", payload: { model: "gpt-test" } },
    { type: "event_msg", timestamp: "2026-07-01T01:00:01Z", payload: { type: "user_message", message: "独特搜索词：海盐柠檬" } },
    { type: "response_item", timestamp: "2026-07-01T01:00:02Z", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "已经处理" }] } },
    { type: "event_msg", timestamp: "2026-07-01T01:00:03Z", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 90, output_tokens: 30, total_tokens: 120 } } } },
  ];
  await writeFile(path.join(codexRoot, `rollout-${id}.jsonl`), `${rows.map(JSON.stringify).join("\n")}\n`);
  const childRows = [
    { type: "session_meta", timestamp: "2026-07-01T01:00:03Z", payload: { id: childId, session_id: id, cwd: "/work/search-demo", thread_source: "subagent", source: { subagent: { other: "guardian" } } } },
    { type: "turn_context", timestamp: "2026-07-01T01:00:03Z", payload: { model: "codex-auto-review" } },
    { type: "event_msg", timestamp: "2026-07-01T01:00:04Z", payload: { type: "user_message", message: "untrusted evidence duplicated parent transcript" } },
    { type: "response_item", timestamp: "2026-07-01T01:00:05Z", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "允许执行 npm start" }] } },
  ];
  await writeFile(path.join(codexRoot, `rollout-${childId}.jsonl`), `${childRows.map(JSON.stringify).join("\n")}\n`);
  const secondId = "22222222-3333-4444-8555-666666666666";
  const secondRows = [
    { type: "session_meta", timestamp: "2026-06-30T01:00:00Z", payload: { id: secondId, cwd: "/work/second-demo" } },
    { type: "turn_context", timestamp: "2026-06-30T01:00:00Z", payload: { model: "gpt-other" } },
    { type: "event_msg", timestamp: "2026-06-30T01:00:01Z", payload: { type: "user_message", message: "第二个 Codex 会话" } },
    { type: "event_msg", timestamp: "2026-06-30T01:00:02Z", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 30, output_tokens: 10, total_tokens: 40 } } } },
  ];
  await writeFile(path.join(codexRoot, `rollout-${secondId}.jsonl`), `${secondRows.map(JSON.stringify).join("\n")}\n`);
  const claudeId = "33333333-4444-4555-8666-777777777777";
  const claudeRows = [
    { type: "user", sessionId: claudeId, cwd: "/work/claude-demo", timestamp: "2026-06-29T01:00:00Z", message: { role: "user", content: "Claude 工作区会话" } },
  ];
  await writeFile(path.join(claudeRoot, `${claudeId}.jsonl`), `${claudeRows.map(JSON.stringify).join("\n")}\n`);
  const store = new HistoryStore({ codexRoot, claudeRoot, stateDir: path.join(root, "state") });
  await store.init();
  const searched = await store.list({ q: "海盐柠檬" });
  assert.equal(searched.total, 1);
  assert.equal(searched.items[0].id, id);
  const visible = await store.list({});
  assert.equal(visible.total, 3);
  assert.deepEqual(visible.facets.sources, { all: 3, codex: 2, claude: 1 });
  assert.equal(visible.facets.workspaces.length, 3);
  assert.equal(visible.items.find((item) => item.id === id).subagentCount, 1);
  const parent = await store.get("codex", id);
  const subagent = parent.messages.find((message) => message.kind === "subagent_session");
  assert.equal(subagent.subagent.id, childId);
  assert.equal(subagent.subagent.label, "权限审查子代理");
  assert.match(subagent.subagent.messages[0].text, /重复的完整对话内容已在此省略/);
  assert.doesNotMatch(JSON.stringify(subagent.subagent.messages), /untrusted evidence/);
  assert.equal(await store.get("codex", childId), null);
  const childSearch = await store.list({ q: "允许执行" });
  assert.equal(childSearch.total, 1);
  assert.equal(childSearch.items[0].id, id);
  assert.equal(store.setFavorite("codex", id, true), true);
  const favorites = await store.list({ favorite: true });
  assert.equal(favorites.items[0].favorite, true);
  assert.equal(favorites.facets.favorites, 1);
  assert.deepEqual(favorites.facets.sources, { all: 1, codex: 1, claude: 0 });
  assert.deepEqual(favorites.facets.workspaces.map((item) => item.name), ["/work/search-demo"]);
  const emptyFavoriteWorkspace = await store.list({ favorite: true, workspace: "/work/second-demo" });
  assert.equal(emptyFavoriteWorkspace.total, 0);
  assert.deepEqual(emptyFavoriteWorkspace.facets.workspaces.map((item) => item.name), ["/work/search-demo"]);
  const workspaceFiltered = await store.list({ source: "codex", workspace: "/work/search-demo" });
  assert.equal(workspaceFiltered.total, 1);
  assert.deepEqual(workspaceFiltered.facets.sources, { all: 3, codex: 2, claude: 1 });
  assert.equal(workspaceFiltered.facets.workspaces.length, 2);
  assert.equal(workspaceFiltered.facets.workspaces.find((item) => item.name === "/work/second-demo").count, 1);
  const stats = await store.stats({});
  assert.deepEqual(stats.models, [
    { name: "gpt-test", count: 1, tokens: 120 },
    { name: "gpt-other", count: 1, tokens: 40 },
  ]);
  const markdown = await store.export("codex", id, "md");
  assert.match(markdown.body, /独特搜索词/);
  const html = await store.export("codex", id, "html");
  assert.match(html.body, /<!doctype html>/);
});

test("history roots fall back to the current user's home directory", () => {
  const home = os.homedir();
  const codexDefault = path.join(home, ".codex", "sessions");
  assert.equal(resolveHistoryRoot(undefined, codexDefault), codexDefault);
  assert.equal(resolveHistoryRoot("", codexDefault), codexDefault);
  assert.equal(resolveHistoryRoot("   ", codexDefault), codexDefault);
  assert.equal(resolveHistoryRoot("~/.codex/sessions", codexDefault), codexDefault);
  assert.equal(resolveHistoryRoot("~", codexDefault), home);
  assert.equal(resolveHistoryRoot("/srv/shared/codex", codexDefault), "/srv/shared/codex");
  assert.equal(resolveHistoryRoot(" /srv/shared/codex ", codexDefault), "/srv/shared/codex");
});

test("HistoryStore ignores blank root overrides instead of scanning the process cwd", () => {
  const previous = { codex: process.env.CODEX_HISTORY_ROOT, claude: process.env.CLAUDE_HISTORY_ROOT };
  process.env.CODEX_HISTORY_ROOT = "";
  process.env.CLAUDE_HISTORY_ROOT = "~/.claude/projects";
  try {
    const store = new HistoryStore();
    assert.equal(store.roots.codex, path.join(os.homedir(), ".codex", "sessions"));
    assert.equal(store.roots.claude, path.join(os.homedir(), ".claude", "projects"));
  } finally {
    for (const [key, value] of [["CODEX_HISTORY_ROOT", previous.codex], ["CLAUDE_HISTORY_ROOT", previous.claude]]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
