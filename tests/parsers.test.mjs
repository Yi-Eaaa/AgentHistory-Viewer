import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseClaude, parseCodex } from "../server/parsers.mjs";

async function fixture(name, rows) {
  const directory = await mkdtemp(path.join(tmpdir(), "agent-history-test-"));
  const target = path.join(directory, name);
  const body = `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
  await writeFile(target, body);
  return { path: target, id: path.basename(name, ".jsonl"), size: Buffer.byteLength(body), mtime: "2026-07-01T00:00:00.000Z", projectHint: "fixture" };
}

test("Codex parser normalizes messages, tools and latest totals", async () => {
  const file = await fixture("codex-session.jsonl", [
    { type: "session_meta", timestamp: "2026-07-01T01:00:00Z", payload: { id: "codex-session", cwd: "/work/demo", originator: "codex" } },
    { type: "turn_context", timestamp: "2026-07-01T01:00:01Z", payload: { model: "gpt-5.6", cwd: "/work/demo" } },
    { type: "event_msg", timestamp: "2026-07-01T01:00:01Z", payload: { type: "task_started", model_context_window: 1000 } },
    { type: "event_msg", timestamp: "2026-07-01T01:00:02Z", payload: { type: "user_message", message: "请检查项目" } },
    { type: "response_item", timestamp: "2026-07-01T01:00:03Z", payload: { type: "function_call", name: "exec_command", call_id: "call-1", arguments: "{\"cmd\":\"ls\"}" } },
    { type: "response_item", timestamp: "2026-07-01T01:00:04Z", payload: { type: "function_call_output", call_id: "call-1", output: "README.md" } },
    { type: "response_item", timestamp: "2026-07-01T01:00:05Z", payload: { type: "message", role: "assistant", phase: "final", content: [{ type: "output_text", text: "检查完成" }] } },
    { type: "event_msg", timestamp: "2026-07-01T01:00:06Z", payload: { type: "token_count", info: { model_context_window: 1000, last_token_usage: { input_tokens: 120, output_tokens: 30, reasoning_output_tokens: 5, total_tokens: 155 }, total_token_usage: { input_tokens: 120, output_tokens: 30, cached_input_tokens: 40, reasoning_output_tokens: 5, total_tokens: 155 } } } },
  ]);
  const result = await parseCodex(file);
  assert.equal(result.title, "请检查项目");
  const question = result.messages.find((item) => item.kind === "message" && item.role === "user");
  assert.equal(question.inputTokens, 5);
  assert.equal(question.tokenEstimate, true);
  assert.equal(result.project, "/work/demo");
  assert.equal(result.model, "gpt-5.6");
  assert.equal(result.toolCount, 1);
  assert.equal(result.tokens.total, 155);
  const answer = result.messages.find((item) => item.kind === "message" && item.role === "assistant");
  assert.equal(answer.model, "gpt-5.6");
  assert.equal(answer.contextUsed, 155);
  assert.equal(answer.contextWindow, 1000);
  assert.equal(answer.contextPercent, 15.5);
  const tool = result.messages.find((item) => item.kind === "tool_call");
  assert.equal(tool.result, "README.md");
  assert.equal(result.messages.some((item) => item.kind === "tool_result"), false);
});

test("Claude parser normalizes array content and does not double-count repeated usage ids", async () => {
  const usage = { input_tokens: 80, output_tokens: 20, cache_read_input_tokens: 10 };
  const file = await fixture("claude-session.jsonl", [
    { type: "user", sessionId: "claude-session", cwd: "/work/claude-demo", timestamp: "2026-07-02T01:00:00Z", message: { role: "user", content: "运行测试" } },
    { type: "assistant", sessionId: "claude-session", cwd: "/work/claude-demo", timestamp: "2026-07-02T01:00:01Z", message: { id: "msg-1", role: "assistant", model: "claude-sonnet", usage, content: [{ type: "thinking", thinking: "需要先读取文件" }, { type: "tool_use", id: "tool-1", name: "Bash", input: { command: "npm test" } }] } },
    { type: "user", sessionId: "claude-session", cwd: "/work/claude-demo", timestamp: "2026-07-02T01:00:02Z", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tool-1", content: "all passed", is_error: false }] } },
    { type: "assistant", sessionId: "claude-session", cwd: "/work/claude-demo", timestamp: "2026-07-02T01:00:03Z", message: { id: "msg-1", role: "assistant", model: "claude-sonnet", usage, content: [{ type: "text", text: "测试通过" }] } },
  ]);
  const result = await parseClaude(file);
  assert.equal(result.title, "运行测试");
  assert.equal(result.model, "claude-sonnet");
  assert.equal(result.messages.find((item) => item.kind === "message" && item.role === "assistant").model, "claude-sonnet");
  assert.equal(result.tokens.input, 80);
  assert.equal(result.tokens.output, 20);
  assert.equal(result.tokens.cached, 10);
  assert.equal(result.toolCount, 1);
  assert.equal(result.messages.find((item) => item.kind === "tool_call").result, "all passed");
  assert.equal(result.messages.filter((item) => item.kind === "reasoning").length, 1);
});
