/**
 * Combine runs of two or more adjacent tool calls. A lone tool call remains a
 * normal timeline message so the existing compact card is preserved.
 *
 * @template {{ id: string, kind: string }} T
 * @param {T[]} messages
 */
export function groupConsecutiveTools(messages) {
  const timeline = [];
  let index = 0;
  while (index < messages.length) {
    const message = messages[index];
    if (message.kind !== "tool_call") {
      timeline.push({ type: "message", key: message.id, message });
      index += 1;
      continue;
    }
    const tools = [];
    while (index < messages.length && messages[index].kind === "tool_call") {
      tools.push(messages[index]);
      index += 1;
    }
    if (tools.length === 1) {
      timeline.push({ type: "message", key: tools[0].id, message: tools[0] });
    } else {
      timeline.push({ type: "tool-group", key: `tool-group-${tools[0].id}`, messages: tools });
    }
  }
  return timeline;
}
