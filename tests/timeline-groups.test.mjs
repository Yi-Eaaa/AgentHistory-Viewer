import test from "node:test";
import assert from "node:assert/strict";
import { groupConsecutiveTools } from "../app/timeline-groups.mjs";

const message = (id, kind) => ({ id, kind });

test("groups two or more consecutive tool calls", () => {
  const result = groupConsecutiveTools([
    message("user-1", "message"),
    message("tool-1", "tool_call"),
    message("tool-2", "tool_call"),
    message("answer-1", "message"),
  ]);
  assert.deepEqual(result.map((item) => item.type), ["message", "tool-group", "message"]);
  assert.deepEqual(result[1].messages.map((item) => item.id), ["tool-1", "tool-2"]);
});

test("keeps a single tool call as a normal timeline message and respects breaks", () => {
  const result = groupConsecutiveTools([
    message("tool-1", "tool_call"),
    message("answer-1", "message"),
    message("tool-2", "tool_call"),
    message("tool-3", "tool_call"),
  ]);
  assert.equal(result[0].type, "message");
  assert.equal(result[0].message.id, "tool-1");
  assert.equal(result[2].type, "tool-group");
});
