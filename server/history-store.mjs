import { readdir, stat, mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";
import { parseClaude, parseCodex } from "./parsers.mjs";
import {
  createPortableSession,
  importValidatedPortableSession,
  importPortableSession,
  inspectPortableSession,
  preparePortableSession,
  PortableSessionError,
} from "./portable-session.mjs";
import { compactText, dateBucket, htmlEscape } from "./utils.mjs";

const DEFAULT_PORTABLE_IMPORT_TTL_MS = 10 * 60 * 1000;
const DEFAULT_PORTABLE_IMPORT_CACHE_BYTES = 256 * 1024 * 1024;

export function resolveHistoryRoot(configured, fallback) {
  const raw = typeof configured === "string" ? configured.trim() : configured;
  if (!raw) return fallback;
  if (raw === "~") return os.homedir();
  const expanded = raw.startsWith("~/") || raw.startsWith("~\\")
    ? path.join(os.homedir(), raw.slice(2))
    : raw;
  return path.resolve(expanded);
}

async function walkJsonl(root, depth = 6) {
  const files = [];
  async function visit(directory, remaining) {
    if (remaining < 0) return;
    let entries = [];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    await Promise.all(
      entries.map(async (entry) => {
        const target = path.join(directory, entry.name);
        if (entry.isDirectory()) return visit(target, remaining - 1);
        if (!entry.isFile() || !entry.name.endsWith(".jsonl")) return;
        try {
          const info = await stat(target);
          const uuid = entry.name.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i)?.[1];
          files.push({
            path: target,
            id: uuid ?? path.basename(entry.name, ".jsonl"),
            size: info.size,
            mtimeMs: info.mtimeMs,
            mtime: info.mtime.toISOString(),
            projectHint: path.basename(path.dirname(target)),
          });
        } catch {
          // A history file may disappear while an agent is still rotating it.
        }
      }),
    );
  }
  await visit(root, depth);
  return files;
}

function publicSession(session, favorite = false) {
  const metadata = { ...session };
  delete metadata.messages;
  delete metadata.fallbackTitle;
  return { ...metadata, favorite };
}

function searchMatch(session, query) {
  if (!query) return null;
  const lower = query.toLocaleLowerCase();
  const metadata = `${session.title} ${session.cwd} ${session.model ?? ""}`.toLocaleLowerCase();
  if (metadata.includes(lower)) return compactText(session.snippet || session.title, 200);
  const message = session.messages.find((item) => item.text?.toLocaleLowerCase().includes(lower));
  if (!message) return null;
  const index = message.text.toLocaleLowerCase().indexOf(lower);
  const start = Math.max(0, index - 70);
  return compactText(message.text.slice(start, start + 240), 220);
}

function subagentLabel(session) {
  if (session.subagentType === "guardian" || session.model === "codex-auto-review") return "权限审查子代理";
  return session.subagentType ? `${session.subagentType} 子代理` : "Codex 子代理";
}

function subagentMessagesForDisplay(session) {
  if (session.subagentType !== "guardian" && session.model !== "codex-auto-review") return session.messages;
  const visible = session.messages.filter((message) => message.role !== "user");
  return [
    {
      id: `subagent-context-${session.id}`,
      role: "user",
      kind: "message",
      text: "主会话上下文已提交给权限审查器；重复的完整对话内容已在此省略。",
      timestamp: session.startedAt,
      inputTokens: 0,
      tokenEstimate: false,
    },
    ...visible,
  ];
}

function mergeSubagents(parent, children) {
  if (!children.length) return parent;
  const blocks = children
    .sort((a, b) => new Date(a.startedAt ?? 0) - new Date(b.startedAt ?? 0))
    .map((child) => {
      const childMessages = subagentMessagesForDisplay(child);
      const label = subagentLabel(child);
      return {
        id: `subagent-session-${child.id}`,
        role: "subagent",
        kind: "subagent_session",
        text: [label, child.model, ...childMessages.map((message) => message.text)].filter(Boolean).join("\n"),
        timestamp: child.startedAt,
        subagent: {
          id: child.id,
          label,
          type: child.subagentType,
          model: child.model,
          startedAt: child.startedAt,
          updatedAt: child.updatedAt,
          messageCount: child.messageCount,
          toolCount: child.toolCount,
          tokens: child.tokens,
          messages: childMessages,
        },
      };
    });
  const messages = [...parent.messages, ...blocks].sort(
    (a, b) => new Date(a.timestamp ?? 0) - new Date(b.timestamp ?? 0),
  );
  const latest = [parent.updatedAt, ...children.map((child) => child.updatedAt)]
    .filter(Boolean)
    .sort((a, b) => new Date(b) - new Date(a))[0] ?? parent.updatedAt;
  return { ...parent, messages, updatedAt: latest, subagentCount: children.length };
}

export class HistoryStore {
  constructor(options = {}) {
    this.roots = {
      codex: resolveHistoryRoot(
        options.codexRoot ?? process.env.CODEX_HISTORY_ROOT,
        path.join(os.homedir(), ".codex", "sessions"),
      ),
      claude: resolveHistoryRoot(
        options.claudeRoot ?? process.env.CLAUDE_HISTORY_ROOT,
        path.join(os.homedir(), ".claude", "projects"),
      ),
    };
    this.stateDir = options.stateDir ?? process.env.AGENT_HISTORY_STATE ?? path.resolve("state");
    this.files = new Map();
    this.cache = new Map();
    this.db = null;
    this.lastScanAt = null;
    this.portableImports = new Map();
    this.portableImportBytes = 0;
    const configuredImportTtl = Number(options.portableImportTtlMs ?? DEFAULT_PORTABLE_IMPORT_TTL_MS);
    const configuredImportCacheBytes = Number(options.portableImportCacheBytes ?? DEFAULT_PORTABLE_IMPORT_CACHE_BYTES);
    this.portableImportTtlMs = Number.isFinite(configuredImportTtl)
      ? Math.max(1, configuredImportTtl)
      : DEFAULT_PORTABLE_IMPORT_TTL_MS;
    this.portableImportCacheBytes = Number.isFinite(configuredImportCacheBytes)
      ? Math.max(0, configuredImportCacheBytes)
      : DEFAULT_PORTABLE_IMPORT_CACHE_BYTES;
  }

  async init() {
    await mkdir(this.stateDir, { recursive: true });
    this.db = new DatabaseSync(path.join(this.stateDir, "history.db"));
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS favorites (
        source TEXT NOT NULL,
        session_id TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (source, session_id)
      );
    `);
    await this.refresh();
  }

  favoriteSet() {
    const rows = this.db.prepare("SELECT source, session_id FROM favorites").all();
    return new Set(rows.map((row) => `${row.source}:${row.session_id}`));
  }

  async refresh() {
    const [codexFiles, claudeFiles] = await Promise.all([
      walkJsonl(this.roots.codex),
      walkJsonl(this.roots.claude),
    ]);
    const next = new Map();
    for (const [source, files] of [["codex", codexFiles], ["claude", claudeFiles]]) {
      for (const file of files) {
        const key = `${source}:${file.id}`;
        next.set(key, { ...file, source });
        const cached = this.cache.get(key);
        if (cached && (cached.mtimeMs !== file.mtimeMs || cached.size !== file.size)) this.cache.delete(key);
      }
    }
    this.files = next;
    this.lastScanAt = new Date().toISOString();
    return { codex: codexFiles.length, claude: claudeFiles.length, total: next.size, scannedAt: this.lastScanAt };
  }

  async load(key) {
    const file = this.files.get(key);
    if (!file) return null;
    const cached = this.cache.get(key);
    if (cached && cached.mtimeMs === file.mtimeMs && cached.size === file.size) return cached.session;
    const session = file.source === "codex" ? await parseCodex(file) : await parseClaude(file);
    // The session id embedded in a file can be cleaner than its filename. Keep both addressable.
    session.id = file.id;
    const next = { mtimeMs: file.mtimeMs, size: file.size, session };
    this.cache.set(key, next);
    return session;
  }

  async loadAll(source = "all") {
    const keys = [...this.files.keys()].filter((key) => source === "all" || key.startsWith(`${source}:`));
    const sessions = await Promise.all(keys.map((key) => this.load(key)));
    const raw = sessions.filter(Boolean);
    const codexById = new Map(raw.filter((session) => session.source === "codex").map((session) => [session.id, session]));
    const childrenByParent = new Map();
    for (const session of raw) {
      if (session.source !== "codex" || !session.isSubagent || !session.parentSessionId) continue;
      if (!codexById.has(session.parentSessionId)) continue;
      const children = childrenByParent.get(session.parentSessionId) ?? [];
      children.push(session);
      childrenByParent.set(session.parentSessionId, children);
    }
    return raw
      .filter((session) => !session.isSubagent || !session.parentSessionId || !codexById.has(session.parentSessionId))
      .map((session) => mergeSubagents(session, childrenByParent.get(session.id) ?? []));
  }

  async list(params = {}) {
    const source = ["codex", "claude"].includes(params.source) ? params.source : "all";
    const query = String(params.q ?? "").trim();
    const workspace = String(params.workspace ?? params.project ?? "").trim();
    const favoritesOnly = params.favorite === "true" || params.favorite === true;
    const limit = Math.min(250, Math.max(1, Number(params.limit ?? 100)));
    const offset = Math.max(0, Number(params.offset ?? 0));
    const favorites = this.favoriteSet();

    const allSessions = await this.loadAll("all");
    const favoriteSessions = allSessions.filter((session) => favorites.has(`${session.source}:${session.id}`));
    const scopedSessions = favoritesOnly ? favoriteSessions : allSessions;
    const sourceCounts = { all: scopedSessions.length, codex: 0, claude: 0 };
    for (const session of scopedSessions) sourceCounts[session.source] += 1;

    const sourceSessions = source === "all"
      ? scopedSessions
      : scopedSessions.filter((session) => session.source === source);
    const workspaceMap = new Map();
    for (const session of sourceSessions) {
      const item = workspaceMap.get(session.project) ?? { name: session.project, count: 0, sources: new Set() };
      item.count += 1;
      item.sources.add(session.source);
      workspaceMap.set(session.project, item);
    }
    const workspaces = [...workspaceMap.values()]
      .map((item) => ({ ...item, sources: [...item.sources].sort() }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

    let sessions = sourceSessions;
    sessions = sessions.filter((session) => {
      if (workspace && session.project !== workspace) return false;
      if (query && !searchMatch(session, query)) return false;
      return true;
    });
    sessions.sort((a, b) => new Date(b.updatedAt ?? 0) - new Date(a.updatedAt ?? 0));
    return {
      items: sessions.slice(offset, offset + limit).map((session) => ({
        ...publicSession(session, favorites.has(`${session.source}:${session.id}`)),
        match: query ? searchMatch(session, query) : null,
      })),
      total: sessions.length,
      facets: {
        sources: sourceCounts,
        workspaces,
        favorites: favoriteSessions.length,
      },
      scannedAt: this.lastScanAt,
    };
  }

  async get(source, id) {
    const sessions = await this.loadAll(source);
    const session = sessions.find((item) => item.id === id);
    if (!session) return null;
    const favorite = this.favoriteSet().has(`${source}:${id}`);
    return { ...session, favorite };
  }

  setFavorite(source, id, enabled) {
    if (!this.files.has(`${source}:${id}`)) return false;
    if (enabled) {
      this.db.prepare("INSERT OR IGNORE INTO favorites (source, session_id) VALUES (?, ?)").run(source, id);
    } else {
      this.db.prepare("DELETE FROM favorites WHERE source = ? AND session_id = ?").run(source, id);
    }
    return true;
  }

  async stats(params = {}) {
    const source = ["codex", "claude"].includes(params.source) ? params.source : "all";
    const granularity = ["day", "month", "year"].includes(params.granularity) ? params.granularity : "day";
    const from = params.from ? new Date(params.from) : null;
    const to = params.to ? new Date(params.to) : null;
    let sessions = await this.loadAll(source);
    sessions = sessions.filter((session) => {
      const date = new Date(session.startedAt ?? 0);
      return (!from || date >= from) && (!to || date <= to);
    });
    const buckets = new Map();
    const heatmap = new Map();
    const sourceTotals = { codex: 0, claude: 0 };
    const modelTotals = new Map();
    const totals = { sessions: sessions.length, messages: 0, tools: 0, input: 0, output: 0, cached: 0, reasoning: 0, tokens: 0 };
    for (const session of sessions) {
      totals.messages += session.messageCount;
      totals.tools += session.toolCount;
      totals.input += session.tokens.input;
      totals.output += session.tokens.output;
      totals.cached += session.tokens.cached;
      totals.reasoning += session.tokens.reasoning;
      totals.tokens += session.tokens.total;
      sourceTotals[session.source] += 1;
      if (session.model) {
        const model = modelTotals.get(session.model) ?? { name: session.model, count: 0, tokens: 0 };
        model.count += 1;
        model.tokens += session.tokens.total;
        modelTotals.set(session.model, model);
      }
      const bucket = dateBucket(session.startedAt, granularity);
      if (bucket) {
        const item = buckets.get(bucket) ?? { date: bucket, sessions: 0, messages: 0, tokens: 0 };
        item.sessions += 1;
        item.messages += session.messageCount;
        item.tokens += session.tokens.total;
        buckets.set(bucket, item);
      }
      const day = dateBucket(session.startedAt, "day");
      if (day) heatmap.set(day, (heatmap.get(day) ?? 0) + 1);
    }
    return {
      totals,
      sources: sourceTotals,
      models: [...modelTotals.values()].sort((a, b) => b.tokens - a.tokens || b.count - a.count || a.name.localeCompare(b.name)),
      timeline: [...buckets.values()].sort((a, b) => a.date.localeCompare(b.date)),
      heatmap: [...heatmap.entries()].map(([date, count]) => ({ date, count })).sort((a, b) => a.date.localeCompare(b.date)),
    };
  }

  async export(source, id, format = "md") {
    const session = await this.get(source, id);
    if (!session) return null;
    if (format === "html") {
      const blocks = session.messages.map((message) => {
        const title = message.kind === "tool_call" ? `工具 · ${message.toolName}` : message.kind === "reasoning" ? "思考" : message.role === "user" ? "提问" : "回答";
        const result = message.result ? `<details><summary>工具结果</summary><pre>${htmlEscape(message.result)}</pre></details>` : "";
        return `<section class="message ${message.role}"><h3>${htmlEscape(title)}</h3><pre>${htmlEscape(message.text)}</pre>${result}</section>`;
      }).join("\n");
      return {
        contentType: "text/html; charset=utf-8",
        extension: "html",
        body: `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${htmlEscape(session.title)}</title><style>body{max-width:900px;margin:40px auto;padding:0 24px;font:16px/1.65 system-ui;color:#18201d;background:#f7f8f4}header{border-bottom:1px solid #ccd4ce;margin-bottom:30px}.message{background:white;border:1px solid #dfe4df;border-radius:14px;padding:16px 20px;margin:14px 0}.user{border-left:4px solid #315aef}.tool{border-left:4px solid #e98b2a}pre{white-space:pre-wrap;font:inherit}details pre{font-family:ui-monospace,monospace;font-size:13px;background:#f1f3ef;padding:12px}</style></head><body><header><h1>${htmlEscape(session.title)}</h1><p>${htmlEscape(session.source)} · ${htmlEscape(session.cwd)} · ${htmlEscape(session.startedAt ?? "")}</p></header>${blocks}</body></html>`,
      };
    }
    const body = [
      `# ${session.title}`,
      "",
      `- 来源：${session.source}`,
      `- 项目：${session.cwd || session.project}`,
      `- 时间：${session.startedAt ?? "未知"}`,
      `- 模型：${session.model ?? "未知"}`,
      "",
      ...session.messages.flatMap((message) => {
        const title = message.kind === "tool_call" ? `工具：${message.toolName}` : message.kind === "reasoning" ? "思考" : message.role === "user" ? "提问" : "回答";
        const result = message.result ? ["", "<details>", "<summary>工具结果</summary>", "", "```text", message.result, "```", "</details>"] : [];
        return [`## ${title}`, "", message.text, ...result, ""];
      }),
    ].join("\n");
    return { contentType: "text/markdown; charset=utf-8", extension: "md", body };
  }

  async exportPortable(source, id) {
    return createPortableSession(this, source, id);
  }

  prunePortableImports(now = Date.now()) {
    for (const [token, entry] of this.portableImports) {
      if (entry.expiresAt > now || entry.inUse) continue;
      this.portableImports.delete(token);
      this.portableImportBytes -= entry.bytes;
    }
  }

  evictPortableImports(requiredBytes) {
    this.prunePortableImports();
    if (requiredBytes > this.portableImportCacheBytes) return false;
    for (const [token, entry] of this.portableImports) {
      if (this.portableImportBytes + requiredBytes <= this.portableImportCacheBytes) break;
      if (entry.inUse) continue;
      this.portableImports.delete(token);
      this.portableImportBytes -= entry.bytes;
    }
    return this.portableImportBytes + requiredBytes <= this.portableImportCacheBytes;
  }

  async preparePortable(buffer) {
    const { preview, validated } = await preparePortableSession(this, buffer);
    const bytes = Object.values(validated.files).reduce((sum, file) => sum + file.byteLength, 0);
    if (!this.evictPortableImports(bytes)) {
      return { ...preview, importToken: null, importTokenExpiresAt: null };
    }
    const importToken = randomUUID();
    const expiresAt = Date.now() + this.portableImportTtlMs;
    this.portableImports.set(importToken, {
      validated,
      bytes,
      expiresAt,
      inUse: false,
    });
    this.portableImportBytes += bytes;
    return {
      ...preview,
      importToken,
      importTokenExpiresAt: new Date(expiresAt).toISOString(),
    };
  }

  async importPreparedPortable(importToken, options = {}) {
    this.prunePortableImports();
    const token = String(importToken ?? "");
    const entry = this.portableImports.get(token);
    if (!entry) {
      throw new PortableSessionError("导入检查结果已过期，请重新选择压缩包", {
        code: "IMPORT_TOKEN_EXPIRED",
        status: 410,
      });
    }
    if (entry.inUse) {
      throw new PortableSessionError("该会话正在导入，请勿重复提交", {
        code: "IMPORT_IN_PROGRESS",
        status: 409,
      });
    }
    entry.inUse = true;
    try {
      const imported = await importValidatedPortableSession(this, entry.validated, options);
      this.portableImports.delete(token);
      this.portableImportBytes -= entry.bytes;
      return imported;
    } finally {
      const retained = this.portableImports.get(token);
      if (retained) retained.inUse = false;
    }
  }

  async inspectPortable(buffer) {
    return inspectPortableSession(this, buffer);
  }

  async importPortable(buffer, options = {}) {
    return importPortableSession(this, buffer, options);
  }
}
