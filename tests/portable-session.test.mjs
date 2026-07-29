import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { HistoryStore } from "../server/history-store.mjs";
import { PortableSessionError } from "../server/portable-session.mjs";

async function makeStore(root, name) {
  const profile = path.join(root, name);
  const codexRoot = path.join(profile, ".codex", "sessions");
  const claudeRoot = path.join(profile, ".claude", "projects");
  await mkdir(codexRoot, { recursive: true });
  await mkdir(claudeRoot, { recursive: true });
  const store = new HistoryStore({
    codexRoot,
    claudeRoot,
    stateDir: path.join(profile, "state"),
  });
  return { profile, codexRoot, claudeRoot, store };
}

test("Codex portable archive includes descendants, round-trips, checks conflict and backs up overwrite", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agenthistory-portable-codex-"));
  const source = await makeStore(root, "source");
  const target = await makeStore(root, "target");
  const id = "019f7f69-8054-7a70-ac08-8f3a0f3fb2cd";
  const childId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const directory = path.join(source.codexRoot, "2026", "07", "29");
  await mkdir(directory, { recursive: true });
  const mainRows = [
    { type: "session_meta", timestamp: "2026-07-29T01:00:00Z", payload: { id, cwd: "/work/original", cli_version: "0.142.5" } },
    { type: "turn_context", timestamp: "2026-07-29T01:00:00Z", payload: { model: "gpt-test", cwd: "/work/original" } },
    { type: "event_msg", timestamp: "2026-07-29T01:00:01Z", payload: { type: "user_message", message: "portable codex question" } },
  ];
  const childRows = [
    { type: "session_meta", timestamp: "2026-07-29T01:00:02Z", payload: { id: childId, session_id: id, cwd: "/work/original", thread_source: "subagent" } },
    { type: "response_item", timestamp: "2026-07-29T01:00:03Z", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "child answer" }] } },
  ];
  const mainPath = path.join(directory, `rollout-${id}.jsonl`);
  await writeFile(mainPath, `${mainRows.map(JSON.stringify).join("\n")}\n`);
  await writeFile(path.join(directory, `rollout-${childId}.jsonl`), `${childRows.map(JSON.stringify).join("\n")}\n`);
  await source.store.init();
  await target.store.init();

  const exported = await source.store.exportPortable("codex", id);
  assert.equal(exported.manifest.files.filter((file) => file.role === "subagent").length, 1);
  const preview = await target.store.inspectPortable(exported.body);
  assert.equal(preview.conflict, false);
  assert.equal(preview.sessionId, id);
  assert.equal(preview.subagentCount, 1);

  const imported = await target.store.importPortable(exported.body, { mode: "original" });
  assert.equal(imported.sessionId, id);
  assert.equal(imported.workspace, "/work/original");
  assert.match(imported.resume.command, new RegExp(`codex -C .* resume ${id}`));
  const restored = await target.store.get("codex", id);
  assert.equal(restored.subagentCount, 1);
  const index = await readFile(path.join(target.profile, ".codex", "session_index.jsonl"), "utf8");
  assert.match(index, new RegExp(id));

  const conflictingPreview = await target.store.inspectPortable(exported.body);
  assert.equal(conflictingPreview.conflict, true);
  await assert.rejects(
    target.store.importPortable(exported.body, { mode: "original" }),
    (error) => error instanceof PortableSessionError && error.code === "SESSION_CONFLICT",
  );

  const targetMain = target.store.files.get(`codex:${id}`).path;
  await writeFile(targetMain, "locally changed");
  const overwritten = await target.store.importPortable(exported.body, { mode: "original", overwrite: true });
  assert.equal(overwritten.overwritten, true);
  assert.ok(overwritten.backupPath);
  assert.equal(await readFile(targetMain, "utf8"), await readFile(mainPath, "utf8"));
});

test("Claude portable archive maps a foreign workspace without changing message content", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agenthistory-portable-claude-"));
  const source = await makeStore(root, "source");
  const target = await makeStore(root, "target");
  const id = "33333333-4444-4555-8666-777777777777";
  const originalWorkspace = "/Users/alice/work/demo";
  const mappedWorkspace = "/home/bob/work/demo";
  const projectDirectory = path.join(source.claudeRoot, "-Users-alice-work-demo");
  await mkdir(path.join(projectDirectory, id, "subagents"), { recursive: true });
  const rows = [
    {
      type: "user",
      sessionId: id,
      cwd: originalWorkspace,
      timestamp: "2026-07-29T02:00:00Z",
      message: { role: "user", content: `Do not rewrite this historical path: ${originalWorkspace}/README.md` },
    },
    {
      type: "assistant",
      sessionId: id,
      cwd: originalWorkspace,
      timestamp: "2026-07-29T02:00:01Z",
      message: { role: "assistant", model: "claude-test", content: "mapped answer" },
    },
  ];
  await writeFile(path.join(projectDirectory, `${id}.jsonl`), `${rows.map(JSON.stringify).join("\n")}\n`);
  await writeFile(path.join(projectDirectory, id, "subagents", "agent-note.jsonl"), `${JSON.stringify({ sessionId: id, cwd: originalWorkspace })}\n`);
  const checkpoint = path.join(source.profile, ".claude", "file-history", id, "checkpoint.txt");
  await mkdir(path.dirname(checkpoint), { recursive: true });
  await writeFile(checkpoint, "checkpoint snapshot");
  await source.store.init();
  await target.store.init();

  const exported = await source.store.exportPortable("claude", id);
  assert.equal(exported.manifest.files.some((file) => file.role === "checkpoint"), true);
  const imported = await target.store.importPortable(exported.body, {
    mode: "mapped",
    workspace: mappedWorkspace,
  });
  assert.equal(imported.workspace, mappedWorkspace);
  assert.match(imported.resume.command, /claude --resume/);
  const restored = await target.store.get("claude", id);
  assert.equal(restored.cwd, mappedWorkspace);
  assert.match(restored.messages[0].text, new RegExp(originalWorkspace));
  const targetMain = path.join(target.claudeRoot, "-home-bob-work-demo", `${id}.jsonl`);
  const restoredBody = await readFile(targetMain, "utf8");
  assert.match(restoredBody, /"cwd":"\/home\/bob\/work\/demo"/);
  assert.match(restoredBody, new RegExp(originalWorkspace.replaceAll("/", "\\/")));
  assert.equal(
    await readFile(path.join(target.profile, ".claude", "file-history", id, "checkpoint.txt"), "utf8"),
    "checkpoint snapshot",
  );
});
