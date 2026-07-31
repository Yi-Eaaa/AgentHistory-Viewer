import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  asText,
  compactText,
  estimateTokens,
  isoDate,
  safeJson,
  stableId,
  stripInjectedContext,
} from "./utils.mjs";

function baseMessage({ source, sessionId, index, timestamp, role, kind = "message", text = "", ...rest }) {
  const normalizedText = asText(text).trim();
  const message = {
    id: stableId(source, sessionId, String(index), kind, rest.toolId ?? ""),
    role,
    kind,
    text: normalizedText,
    timestamp: isoDate(timestamp),
    ...rest,
  };
  if (role === "user" && kind === "message") {
    message.inputTokens = estimateTokens(normalizedText);
    message.tokenEstimate = true;
  }
  return message;
}

function pairTools(messages) {
  const calls = new Map();
  const output = [];
  for (const message of messages) {
    if (message.kind === "tool_call" && message.toolId) {
      calls.set(message.toolId, message);
      output.push(message);
      continue;
    }
    if (message.kind === "tool_result" && message.toolId && calls.has(message.toolId)) {
      const call = calls.get(message.toolId);
      call.result = message.text;
      call.isError = Boolean(message.isError);
      call.resultTimestamp = message.timestamp;
      continue;
    }
    output.push(message);
  }
  return output;
}

function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return asText(content);
  return content
    .filter((item) => item && ["text", "input_text", "output_text"].includes(item.type))
    .map((item) => asText(item.text))
    .filter(Boolean)
    .join("\n");
}

function contextDetails(usage, windowSize) {
  const contextWindow = Number(windowSize ?? 0);
  if (!usage || !Number.isFinite(contextWindow) || contextWindow <= 0) return {};
  const contextUsed = Number(
    usage.total_tokens ??
      Number(usage.input_tokens ?? 0) +
        Number(usage.output_tokens ?? 0) +
        Number(usage.reasoning_output_tokens ?? 0),
  );
  if (!Number.isFinite(contextUsed) || contextUsed <= 0) return {};
  return {
    contextUsed,
    contextWindow,
    contextPercent: Math.min(100, Math.max(0, (contextUsed / contextWindow) * 100)),
  };
}

function subagentTypeFromSource(source) {
  const subagent = source?.subagent;
  if (!subagent) return null;
  if (typeof subagent === "string") return subagent;
  if (typeof subagent.other === "string") return subagent.other;
  const [type] = Object.keys(subagent);
  return type || "subagent";
}

function finalizeSession(base, messages, tokenUsage, models) {
  const { nativeTitle, ...sessionBase } = base;
  const visible = messages.filter((item) => item.text || item.kind === "tool_call");
  const firstQuestion = visible.find((item) => item.role === "user" && item.kind === "message");
  const lastTimestamp = [...visible].reverse().find((item) => item.timestamp)?.timestamp;
  const model = [...models.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? base.model ?? null;
  const userCount = visible.filter((item) => item.role === "user" && item.kind === "message").length;
  const assistantCount = visible.filter((item) => item.role === "assistant" && item.kind === "message").length;
  const toolCount = visible.filter((item) => item.kind === "tool_call").length;
  const title =
    compactText(nativeTitle ?? "", 240) ||
    compactText(stripInjectedContext(firstQuestion?.text ?? ""), 86) ||
    base.fallbackTitle;
  return {
    ...sessionBase,
    title,
    snippet: compactText(stripInjectedContext(firstQuestion?.text ?? ""), 180),
    startedAt: base.startedAt ?? visible.find((item) => item.timestamp)?.timestamp ?? null,
    updatedAt: lastTimestamp ?? base.startedAt ?? null,
    model,
    messageCount: userCount + assistantCount,
    userCount,
    assistantCount,
    toolCount,
    tokens: {
      input: tokenUsage.input || 0,
      output: tokenUsage.output || 0,
      cached: tokenUsage.cached || 0,
      reasoning: tokenUsage.reasoning || 0,
      total:
        tokenUsage.total ||
        (tokenUsage.input || 0) + (tokenUsage.output || 0) + (tokenUsage.reasoning || 0),
    },
    messages: visible,
  };
}

export async function parseCodex(file) {
  const body = await readFile(file.path, "utf8");
  const rows = body.split("\n").filter(Boolean);
  const messages = [];
  const models = new Map();
  let sessionId = file.id;
  let cwd = "";
  let startedAt = file.mtime;
  let originator = "Codex";
  let tokenUsage = {};
  let currentModel = null;
  let currentContextWindow = null;
  let pendingAssistantMessages = [];
  let parentSessionId = null;
  let threadSource = null;
  let subagentType = null;

  rows.forEach((line, index) => {
    const row = safeJson(line);
    if (!row) return;
    const payload = row.payload ?? {};
    const timestamp = row.timestamp ?? payload.timestamp ?? null;

    if (row.type === "session_meta") {
      const ownSessionId = payload.id ?? sessionId;
      const linkedSessionId = payload.session_id ?? ownSessionId;
      sessionId = ownSessionId;
      cwd = payload.cwd ?? cwd;
      startedAt = isoDate(payload.timestamp ?? timestamp, startedAt);
      originator = payload.originator ?? payload.source ?? originator;
      threadSource = payload.thread_source ?? threadSource;
      subagentType = subagentTypeFromSource(payload.source) ?? subagentType;
      if ((threadSource === "subagent" || subagentType) && linkedSessionId !== ownSessionId) {
        parentSessionId = linkedSessionId;
      }
      if (payload.model) {
        currentModel = payload.model;
        models.set(payload.model, (models.get(payload.model) ?? 0) + 1);
      }
      return;
    }
    if (row.type === "turn_context") {
      cwd = payload.cwd ?? cwd;
      if (payload.model) {
        currentModel = payload.model;
        models.set(payload.model, (models.get(payload.model) ?? 0) + 1);
      }
      return;
    }
    if (row.type === "event_msg") {
      if (payload.type === "task_started") {
        currentContextWindow = Number(payload.model_context_window ?? currentContextWindow) || null;
        pendingAssistantMessages = [];
      } else if (payload.type === "user_message") {
        pendingAssistantMessages = [];
        const text = stripInjectedContext(payload.message ?? "");
        if (text) {
          messages.push(baseMessage({ source: "codex", sessionId, index, timestamp, role: "user", text }));
        }
      } else if (payload.type === "token_count" && payload.info?.total_token_usage) {
        const usage = payload.info.total_token_usage;
        currentContextWindow = Number(payload.info.model_context_window ?? currentContextWindow) || null;
        tokenUsage = {
          input: Number(usage.input_tokens ?? 0),
          output: Number(usage.output_tokens ?? 0),
          cached: Number(usage.cached_input_tokens ?? usage.cache_read_input_tokens ?? 0),
          reasoning: Number(usage.reasoning_output_tokens ?? 0),
          total: Number(usage.total_tokens ?? 0),
        };
        const details = contextDetails(payload.info.last_token_usage, currentContextWindow);
        if (details.contextWindow) {
          for (const message of pendingAssistantMessages) Object.assign(message, details);
        }
        pendingAssistantMessages = [];
      }
      return;
    }
    if (row.type !== "response_item") return;

    if (payload.type === "message" && payload.role === "assistant") {
      const text = contentText(payload.content);
      if (text) {
        const message = baseMessage({
          source: "codex",
          sessionId,
          index,
          timestamp,
          role: "assistant",
          kind: "message",
          text,
          phase: payload.phase ?? null,
          model: currentModel,
        });
        messages.push(message);
        pendingAssistantMessages.push(message);
      }
    } else if (payload.type === "reasoning") {
      const text = contentText(payload.summary);
      if (text) {
        messages.push(baseMessage({ source: "codex", sessionId, index, timestamp, role: "assistant", kind: "reasoning", text }));
      }
    } else if (["function_call", "custom_tool_call"].includes(payload.type)) {
      messages.push(
        baseMessage({
          source: "codex",
          sessionId,
          index,
          timestamp,
          role: "assistant",
          kind: "tool_call",
          text: asText(payload.arguments ?? payload.input ?? ""),
          toolName: payload.name ?? "tool",
          toolId: payload.call_id ?? payload.id ?? stableId(sessionId, String(index)),
        }),
      );
    } else if (["function_call_output", "custom_tool_call_output"].includes(payload.type)) {
      messages.push(
        baseMessage({
          source: "codex",
          sessionId,
          index,
          timestamp,
          role: "tool",
          kind: "tool_result",
          text: asText(payload.output ?? payload.content ?? ""),
          toolId: payload.call_id ?? payload.id,
        }),
      );
    }
  });

  return finalizeSession(
    {
      id: sessionId,
      source: "codex",
      project: cwd || "Codex",
      cwd,
      originator,
      fallbackTitle: path.basename(file.path, ".jsonl"),
      fileName: path.basename(file.path),
      sizeBytes: file.size,
      startedAt,
      parentSessionId,
      threadSource,
      subagentType,
      isSubagent: Boolean(parentSessionId || threadSource === "subagent" || subagentType),
    },
    pairTools(messages),
    tokenUsage,
    models,
  );
}

export async function parseClaude(file) {
  const body = await readFile(file.path, "utf8");
  const rows = body.split("\n").filter(Boolean);
  const messages = [];
  const models = new Map();
  const usageSeen = new Set();
  let sessionId = file.id;
  let cwd = "";
  let startedAt = file.mtime;
  let customTitle = null;
  let aiTitle = null;
  let summaryTitle = null;
  const tokenUsage = { input: 0, output: 0, cached: 0, reasoning: 0, total: 0 };

  rows.forEach((line, index) => {
    const row = safeJson(line);
    if (!row) return;
    sessionId = row.sessionId ?? sessionId;
    cwd = row.cwd ?? cwd;
    const timestamp = row.timestamp ?? null;
    if (timestamp && (!startedAt || new Date(timestamp) < new Date(startedAt))) startedAt = isoDate(timestamp, startedAt);
    if (row.type === "custom-title") {
      customTitle = asText(row.customTitle ?? row.custom_title ?? row.title).trim() || null;
      return;
    }
    if (row.type === "ai-title") {
      aiTitle = asText(row.aiTitle ?? row.ai_title ?? row.title).trim() || null;
      return;
    }
    if (row.type === "summary") {
      summaryTitle = asText(row.summary ?? row.title).trim() || summaryTitle;
      return;
    }
    const role = row.message?.role ?? row.type;
    const content = row.message?.content;
    const messageModel = row.message?.model ?? null;
    if (messageModel) models.set(messageModel, (models.get(messageModel) ?? 0) + 1);
    const usage = row.message?.usage;
    const messageContext = contextDetails(
      usage,
      row.message?.context_window ?? row.message?.contextWindow ?? row.context_window ?? row.contextWindow,
    );
    const usageKey = row.message?.id ?? row.uuid ?? `${index}`;
    if (usage && !usageSeen.has(usageKey)) {
      usageSeen.add(usageKey);
      tokenUsage.input += Number(usage.input_tokens ?? 0);
      tokenUsage.output += Number(usage.output_tokens ?? 0);
      tokenUsage.cached += Number(usage.cache_read_input_tokens ?? 0) + Number(usage.cache_creation_input_tokens ?? 0);
    }

    if (typeof content === "string") {
      if (["user", "assistant"].includes(role) && content.trim()) {
        messages.push(
          baseMessage({
            source: "claude",
            sessionId,
            index,
            timestamp,
            role,
            text: content,
            ...(role === "assistant" ? { model: messageModel, ...messageContext } : {}),
          }),
        );
      }
      return;
    }
    if (!Array.isArray(content)) return;
    content.forEach((item, contentIndex) => {
      const itemIndex = `${index}.${contentIndex}`;
      if (item?.type === "text" && item.text?.trim()) {
        messages.push(
          baseMessage({
            source: "claude",
            sessionId,
            index: itemIndex,
            timestamp,
            role,
            text: item.text,
            ...(role === "assistant" ? { model: messageModel, ...messageContext } : {}),
          }),
        );
      } else if (item?.type === "thinking" && item.thinking?.trim()) {
        messages.push(
          baseMessage({ source: "claude", sessionId, index: itemIndex, timestamp, role: "assistant", kind: "reasoning", text: item.thinking }),
        );
      } else if (item?.type === "tool_use") {
        messages.push(
          baseMessage({
            source: "claude",
            sessionId,
            index: itemIndex,
            timestamp,
            role: "assistant",
            kind: "tool_call",
            text: asText(item.input),
            toolName: item.name ?? "tool",
            toolId: item.id ?? stableId(sessionId, itemIndex),
          }),
        );
      } else if (item?.type === "tool_result") {
        messages.push(
          baseMessage({
            source: "claude",
            sessionId,
            index: itemIndex,
            timestamp,
            role: "tool",
            kind: "tool_result",
            text: asText(item.content),
            toolId: item.tool_use_id,
            isError: Boolean(item.is_error),
          }),
        );
      }
    });
  });
  tokenUsage.total = tokenUsage.input + tokenUsage.output;

  return finalizeSession(
    {
      id: sessionId,
      source: "claude",
      project: cwd || file.projectHint || "Claude Code",
      cwd,
      originator: "Claude Code",
      fallbackTitle: path.basename(file.path, ".jsonl"),
      fileName: path.basename(file.path),
      sizeBytes: file.size,
      startedAt,
      nativeTitle: customTitle ?? aiTitle ?? summaryTitle,
    },
    pairTools(messages),
    tokenUsage,
    models,
  );
}
