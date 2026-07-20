import { createHash } from "node:crypto";

export function safeJson(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

export function asText(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === "string") return item;
        if (item && typeof item === "object") {
          return asText(item.text ?? item.content ?? item.output ?? item);
        }
        return asText(item);
      })
      .filter(Boolean)
      .join("\n");
  }
  if (typeof value === "object") {
    if (typeof value.text === "string") return value.text;
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

export function compactText(value, limit = 160) {
  const text = asText(value).replace(/\s+/g, " ").trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

export function isoDate(value, fallback = null) {
  if (!value) return fallback;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? fallback : date.toISOString();
}

export function stableId(...parts) {
  return createHash("sha1").update(parts.join("\0")).digest("hex").slice(0, 16);
}

export function htmlEscape(value) {
  return asText(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export function dateBucket(value, granularity) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const year = date.getFullYear();
  if (granularity === "year") return String(year);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  if (granularity === "month") return `${year}-${month}`;
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function stripInjectedContext(text) {
  const value = asText(text).trim();
  return value
    .replace(/<environment_context>[\s\S]*?<\/environment_context>/g, "")
    .replace(/<app-context>[\s\S]*?<\/app-context>/g, "")
    .trim();
}

// Codex and Claude Code histories do not expose tokenizer output for the
// standalone user text. This language-aware estimate is intentionally marked
// as approximate by the API and UI.
export function estimateTokens(value) {
  const text = asText(value).trim();
  if (!text) return 0;
  const cjk = text.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/gu)?.length ?? 0;
  const latinTokens = (text.match(/[A-Za-z0-9]+/g) ?? []).reduce(
    (total, word) => total + Math.max(1, Math.ceil(word.length / 4)),
    0,
  );
  const punctuation = text.match(/[^\p{L}\p{N}\s]/gu)?.length ?? 0;
  const coveredLetters = text.match(/[A-Za-z0-9\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/gu)?.length ?? 0;
  const allLetters = text.match(/[\p{L}\p{N}]/gu)?.length ?? 0;
  const otherLetters = Math.max(0, allLetters - coveredLetters);
  return Math.max(1, Math.round(cjk * 1.05 + latinTokens + punctuation * 0.5 + otherLetters));
}
