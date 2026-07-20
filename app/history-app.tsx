"use client";

/* eslint-disable react-hooks/set-state-in-effect -- effects intentionally mirror remote API and persisted UI state */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { UIEvent } from "react";
import { groupConsecutiveTools } from "./timeline-groups.mjs";

type Source = "all" | "codex" | "claude";
type TokenUsage = { input: number; output: number; cached: number; reasoning: number; total: number };
type SessionSummary = {
  id: string;
  source: "codex" | "claude";
  project: string;
  cwd: string;
  title: string;
  snippet: string;
  startedAt: string | null;
  updatedAt: string | null;
  model: string | null;
  messageCount: number;
  toolCount: number;
  subagentCount?: number;
  tokens: TokenUsage;
  favorite: boolean;
  match?: string | null;
};
type Message = {
  id: string;
  role: "user" | "assistant" | "tool" | "subagent";
  kind: "message" | "reasoning" | "tool_call" | "tool_result" | "subagent_session";
  text: string;
  timestamp: string | null;
  phase?: string | null;
  toolName?: string;
  toolId?: string;
  result?: string;
  resultTimestamp?: string;
  isError?: boolean;
  model?: string | null;
  contextUsed?: number;
  contextWindow?: number;
  contextPercent?: number;
  inputTokens?: number;
  tokenEstimate?: boolean;
  subagent?: {
    id: string;
    label: string;
    type?: string | null;
    model?: string | null;
    startedAt: string | null;
    updatedAt: string | null;
    messageCount: number;
    toolCount: number;
    tokens: TokenUsage;
    messages: Message[];
  };
};
type Session = SessionSummary & { messages: Message[] };
type Workspace = { name: string; count: number; sources: ("codex" | "claude")[] };
type SessionFacets = {
  sources: { all: number; codex: number; claude: number };
  workspaces: Workspace[];
  favorites: number;
};
type Stats = {
  totals: { sessions: number; messages: number; tools: number; input: number; output: number; cached: number; reasoning: number; tokens: number };
  sources: { codex: number; claude: number };
  models: { name: string; count: number; tokens: number }[];
  timeline: { date: string; sessions: number; messages: number; tokens: number }[];
  heatmap: { date: string; count: number }[];
};

const number = new Intl.NumberFormat("zh-CN", { notation: "compact", maximumFractionDigits: 1 });
const fullNumber = new Intl.NumberFormat("zh-CN");

function formatNumber(value = 0) {
  return number.format(value);
}

function formatDate(value: string | null, long = false) {
  if (!value) return "未知时间";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "未知时间";
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  if (!long && diff >= 0 && diff < 86_400_000) {
    const hours = Math.floor(diff / 3_600_000);
    if (hours < 1) return `${Math.max(1, Math.floor(diff / 60_000))} 分钟前`;
    return `${hours} 小时前`;
  }
  return new Intl.DateTimeFormat("zh-CN", {
    month: "short",
    day: "numeric",
    ...(long ? { year: "numeric", hour: "2-digit", minute: "2-digit" } : {}),
  }).format(date);
}

function formatTimestamp(value: string | null) {
  if (!value) return "未知";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "未知";
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function shortProject(value: string) {
  if (!value) return "未命名项目";
  const parts = value.replaceAll("\\", "/").split("/").filter(Boolean);
  return parts.at(-1) || value;
}

function workspaceParent(value: string) {
  const parts = value.replaceAll("\\", "/").split("/").filter(Boolean);
  if (parts.length < 2) return value;
  return `…/${parts.at(-2)}`;
}

function sourceLabel(source: Source) {
  return source === "codex" ? "Codex" : source === "claude" ? "Claude Code" : "全部 Agent";
}

async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || `请求失败 (${response.status})`);
  }
  return response.json();
}

function SourceMark({ source }: { source: "codex" | "claude" }) {
  return <span className={`source-mark ${source}`} aria-hidden="true">{source === "codex" ? "C×" : "C"}</span>;
}

function EmptyState({ icon, title, detail }: { icon: string; title: string; detail: string }) {
  return (
    <div className="empty-state">
      <span className="empty-icon">{icon}</span>
      <h3>{title}</h3>
      <p>{detail}</p>
    </div>
  );
}

function ToolCard({ message, query }: { message: Message; query: string }) {
  const [open, setOpen] = useState(false);
  const matched = query && `${message.text}\n${message.result ?? ""}`.toLocaleLowerCase().includes(query.toLocaleLowerCase());
  return (
    <article id={`message-${message.id}`} className={`tool-card ${message.isError ? "error" : ""} ${matched ? "matched" : ""}`}>
      <button className="tool-summary" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        <span className="tool-glyph">›_</span>
        <span className="tool-name">{message.toolName || "tool"}</span>
        <span className="tool-preview">{message.text.replace(/\s+/g, " ").slice(0, 90) || "无参数"}</span>
        {message.isError && <span className="error-badge">失败</span>}
        <span className="chevron">{open ? "−" : "+"}</span>
      </button>
      {open && (
        <div className="tool-body">
          <div><span>调用参数</span><pre>{message.text || "无"}</pre></div>
          {message.result != null && <div><span>运行结果</span><pre>{message.result || "（空结果）"}</pre></div>}
        </div>
      )}
    </article>
  );
}

function ToolCallGroup({ messages, query }: { messages: Message[]; query: string }) {
  const [open, setOpen] = useState(false);
  const counts = new Map<string, number>();
  for (const message of messages) {
    const name = message.toolName || "tool";
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const names = [...counts.entries()].map(([name, count]) => count > 1 ? `${name} ×${count}` : name);
  const preview = names.slice(0, 3).join(" · ");
  const hiddenNames = Math.max(0, names.length - 3);
  const errorCount = messages.filter((message) => message.isError).length;
  return (
    <section className="tool-group">
      <button className="tool-group-summary" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        <span className="tool-glyph">›_</span>
        <strong>{messages.length} 次连续工具调用</strong>
        <span className="tool-group-preview">{preview}{hiddenNames ? ` · +${hiddenNames}` : ""}</span>
        {errorCount > 0 && <span className="error-badge">{errorCount} 次失败</span>}
        <span className="group-state">{open ? "收起" : "展开"}</span>
        <span className="chevron">{open ? "−" : "+"}</span>
      </button>
      {open && (
        <div className="tool-group-body">
          {messages.map((message) => <ToolCard key={message.id} message={message} query={query} />)}
        </div>
      )}
    </section>
  );
}

function SubagentTranscriptMessage({ message, model, query }: { message: Message; model: string | null | undefined; query: string }) {
  if (message.kind === "tool_call") return <ToolCard message={message} query={query} />;
  if (message.kind === "reasoning") {
    return (
      <details className="subagent-reasoning">
        <summary><span>子代理思考</span><time>{formatDate(message.timestamp, true)}</time></summary>
        <pre>{message.text}</pre>
      </details>
    );
  }
  return (
    <article className={`subagent-transcript-message ${message.role}`}>
      <header>
        <strong>{message.role === "user" ? "输入上下文" : message.model || model || "子代理"}</strong>
        <time>{formatDate(message.timestamp, true)}</time>
      </header>
      <pre>{message.text}</pre>
    </article>
  );
}

function SubagentSessionCard({ message, query }: { message: Message; query: string }) {
  const [open, setOpen] = useState(false);
  const subagent = message.subagent!;
  const timeline = groupConsecutiveTools(subagent.messages);
  const matched = query && message.text.toLocaleLowerCase().includes(query.toLocaleLowerCase());
  return (
    <section id={`message-${message.id}`} className={`subagent-card ${matched ? "matched" : ""}`}>
      <button className="subagent-summary" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        <span className="subagent-mark">S</span>
        <span className="subagent-summary-main"><strong>{subagent.label}</strong><small>{subagent.model || "未知模型"}</small></span>
        <span className="subagent-summary-stats">{subagent.messageCount} 条消息 · {subagent.toolCount} 次工具</span>
        <time>{formatDate(subagent.startedAt, true)}</time>
        <span className="group-state">{open ? "收起" : "展开"}</span>
        <span className="chevron">{open ? "−" : "+"}</span>
      </button>
      {open && (
        <div className="subagent-body">
          <div className="subagent-session-meta">
            <span>session_id: {subagent.id}</span>
            <span>{formatNumber(subagent.tokens.total)} tokens</span>
            <span>更新于 {formatTimestamp(subagent.updatedAt)}</span>
          </div>
          <div className="subagent-transcript">
            {timeline.map((item) => item.type === "tool-group"
              ? <ToolCallGroup key={item.key} messages={item.messages!} query={query} />
              : <SubagentTranscriptMessage key={item.key} message={item.message!} model={subagent.model} query={query} />
            )}
          </div>
        </div>
      )}
    </section>
  );
}

function MessageCard({ message, query, fallbackModel }: { message: Message; query: string; fallbackModel: string | null }) {
  if (message.kind === "subagent_session" && message.subagent) return <SubagentSessionCard message={message} query={query} />;
  if (message.kind === "tool_call") return <ToolCard message={message} query={query} />;
  const matched = query && message.text.toLocaleLowerCase().includes(query.toLocaleLowerCase());
  if (message.kind === "reasoning") {
    return (
      <details id={`message-${message.id}`} className={`reasoning-card ${matched ? "matched" : ""}`}>
        <summary><span>思考过程</span><small>{formatDate(message.timestamp)}</small></summary>
        <pre>{message.text}</pre>
      </details>
    );
  }
  const model = message.model || fallbackModel || "Agent";
  const hasContext = Boolean(message.contextUsed && message.contextWindow && message.contextPercent != null);
  return (
    <article id={`message-${message.id}`} className={`message-card ${message.role} ${matched ? "matched" : ""}`}>
      <div className="message-rail"><span>{message.role === "user" ? "你" : "A"}</span></div>
      <div className="message-content">
        {message.role === "user" ? (
          <header className="user-message-meta">
            <span
              className="user-token-count"
              title="历史文件不包含单条提问的精确 tokenizer 结果，此处为本地文本估算"
            >
              {message.tokenEstimate ? "≈ " : ""}{fullNumber.format(message.inputTokens ?? 0)} tokens
            </span>
            <time>{formatDate(message.timestamp, true)}</time>
          </header>
        ) : (
          <header>
            <div className="agent-message-meta">
              <strong>{model}</strong>
              {hasContext && (
                <span
                  className="context-usage"
                  title={`上下文 ${fullNumber.format(message.contextUsed!)} / ${fullNumber.format(message.contextWindow!)} tokens`}
                >
                  <i><b style={{ width: `${message.contextPercent}%` }} /></i>
                  上下文 {Math.round(message.contextPercent!)}%
                </span>
              )}
            </div>
            <time>{formatDate(message.timestamp, true)}</time>
          </header>
        )}
        <pre>{message.text}</pre>
      </div>
    </article>
  );
}

function TimelineChart({ data }: { data: Stats["timeline"] }) {
  const max = Math.max(1, ...data.map((item) => item.tokens));
  if (!data.length) return <EmptyState icon="⌁" title="暂无趋势数据" detail="当前筛选范围内还没有会话。" />;
  return (
    <div className="bar-chart" role="img" aria-label="Token 使用趋势">
      {data.slice(-36).map((item) => (
        <div className="bar-column" key={item.date} title={`${item.date} · ${fullNumber.format(item.tokens)} tokens · ${item.sessions} 个会话`}>
          <span className="bar-value">{formatNumber(item.tokens)}</span>
          <div className="bar-track"><div style={{ height: `${Math.max(4, (item.tokens / max) * 100)}%` }} /></div>
          <span className="bar-label">{item.date.slice(5) || item.date}</span>
        </div>
      ))}
    </div>
  );
}

function Heatmap({ data }: { data: Stats["heatmap"] }) {
  const values = new Map(data.map((item) => [item.date, item.count]));
  const end = new Date();
  const cells = Array.from({ length: 112 }, (_, index) => {
    const date = new Date(end);
    date.setDate(end.getDate() - (111 - index));
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    return { key, count: values.get(key) ?? 0 };
  });
  const max = Math.max(1, ...cells.map((item) => item.count));
  return (
    <div className="heatmap" role="img" aria-label="最近 16 周活动热力图">
      {cells.map((item) => {
        const level = item.count === 0 ? 0 : Math.max(1, Math.ceil((item.count / max) * 4));
        return <span key={item.key} className={`level-${level}`} title={`${item.key} · ${item.count} 个会话`} />;
      })}
    </div>
  );
}

export default function HistoryApp() {
  const [source, setSource] = useState<Source>("all");
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [workspaceFilter, setWorkspaceFilter] = useState("");
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [sourceTotals, setSourceTotals] = useState({ all: 0, codex: 0, claude: 0 });
  const [favoriteCount, setFavoriteCount] = useState(0);
  const [total, setTotal] = useState(0);
  const [selectedKey, setSelectedKey] = useState("");
  const [session, setSession] = useState<Session | null>(null);
  const [loadingList, setLoadingList] = useState(true);
  const [loadingSession, setLoadingSession] = useState(false);
  const [error, setError] = useState("");
  const [view, setView] = useState<"history" | "stats">("history");
  const [sessionQuery, setSessionQuery] = useState("");
  const [questionsOnly, setQuestionsOnly] = useState(false);
  const [showReasoning, setShowReasoning] = useState(true);
  const [stats, setStats] = useState<Stats | null>(null);
  const [granularity, setGranularity] = useState("day");
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [mobileConversationOpen, setMobileConversationOpen] = useState(false);
  const [theme, setTheme] = useState("light");
  const [refreshing, setRefreshing] = useState(false);
  const messageScrollRef = useRef<HTMLDivElement>(null);
  const pendingScrollRestoreRef = useRef<number | null>(null);
  const scrollIdleTimersRef = useRef(new Map<HTMLElement, number>());
  const scrollAnimationRef = useRef<number | null>(null);

  useEffect(() => {
    const saved = window.localStorage.getItem("agent-history-theme");
    if (saved === "dark") setTheme("dark");
  }, []);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    window.localStorage.setItem("agent-history-theme", theme);
  }, [theme]);
  useEffect(() => () => {
    for (const timer of scrollIdleTimersRef.current.values()) window.clearTimeout(timer);
    scrollIdleTimersRef.current.clear();
    if (scrollAnimationRef.current !== null) window.cancelAnimationFrame(scrollAnimationRef.current);
  }, []);
  useLayoutEffect(() => {
    const savedScrollTop = pendingScrollRestoreRef.current;
    const target = messageScrollRef.current;
    if (savedScrollTop === null || !target) return;
    pendingScrollRestoreRef.current = null;
    const previousBehavior = target.style.scrollBehavior;
    target.style.scrollBehavior = "auto";
    target.scrollTop = Math.min(savedScrollTop, Math.max(0, target.scrollHeight - target.clientHeight));
    window.requestAnimationFrame(() => { target.style.scrollBehavior = previousBehavior; });
  }, [session]);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(query), 260);
    return () => window.clearTimeout(timer);
  }, [query]);

  const loadSessions = useCallback(async () => {
    setLoadingList(true);
    setError("");
    try {
      const params = new URLSearchParams({ source, limit: "250" });
      if (debouncedQuery) params.set("q", debouncedQuery);
      if (workspaceFilter) params.set("workspace", workspaceFilter);
      if (favoritesOnly) params.set("favorite", "true");
      const payload = await getJson<{ items: SessionSummary[]; total: number; facets: SessionFacets }>(`/api/sessions?${params}`);
      setSessions(payload.items);
      setWorkspaces(payload.facets.workspaces);
      setSourceTotals(payload.facets.sources);
      setFavoriteCount(payload.facets.favorites);
      setTotal(payload.total);
      if (payload.items.length === 0) {
        setSelectedKey("");
        setSession(null);
      } else if (!selectedKey || !payload.items.some((item) => `${item.source}:${item.id}` === selectedKey)) {
        setSelectedKey(`${payload.items[0].source}:${payload.items[0].id}`);
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "无法读取会话");
    } finally {
      setLoadingList(false);
    }
  }, [source, debouncedQuery, workspaceFilter, favoritesOnly, selectedKey]);

  useEffect(() => { void loadSessions(); }, [loadSessions]);
  useEffect(() => {
    if (!selectedKey) return;
    const [selectedSource, ...idParts] = selectedKey.split(":");
    setLoadingSession(true);
    setSessionQuery("");
    getJson<Session>(`/api/sessions/${selectedSource}/${encodeURIComponent(idParts.join(":"))}`)
      .then(setSession)
      .catch((reason) => setError(reason instanceof Error ? reason.message : "无法读取会话详情"))
      .finally(() => setLoadingSession(false));
  }, [selectedKey]);
  useEffect(() => {
    if (view !== "stats") return;
    setError("");
    getJson<Stats>(`/api/stats?source=${source}&granularity=${granularity}`)
      .then(setStats)
      .catch((reason) => setError(reason instanceof Error ? reason.message : "无法读取统计"));
  }, [view, source, granularity]);

  const visibleMessages = useMemo(() => {
    if (!session) return [];
    return session.messages.filter((message) => {
      if (questionsOnly && message.role !== "user") return false;
      if (!showReasoning && message.kind === "reasoning") return false;
      if (sessionQuery && !`${message.text}\n${message.result ?? ""}`.toLocaleLowerCase().includes(sessionQuery.toLocaleLowerCase())) return false;
      return true;
    });
  }, [session, questionsOnly, showReasoning, sessionQuery]);
  const questions = useMemo(() => session?.messages.filter((item) => item.role === "user" && item.kind === "message") ?? [], [session]);
  const timelineItems = useMemo(() => groupConsecutiveTools(visibleMessages), [visibleMessages]);
  const maxModelTokens = useMemo(() => Math.max(1, ...(stats?.models.map((item) => item.tokens) ?? [])), [stats]);

  async function refresh() {
    if (refreshing) return;
    const scrollTarget = messageScrollRef.current;
    const savedScrollTop = scrollTarget?.scrollTop ?? null;
    setRefreshing(true);
    setError("");
    try {
      await getJson("/api/refresh", { method: "POST" });
      await loadSessions();
      if (selectedKey) {
        const [selectedSource, ...idParts] = selectedKey.split(":");
        const refreshedSession = await getJson<Session>(`/api/sessions/${selectedSource}/${encodeURIComponent(idParts.join(":"))}`);
        pendingScrollRestoreRef.current = savedScrollTop;
        setSession(refreshedSession);
      }
      if (view === "stats") {
        setStats(await getJson<Stats>(`/api/stats?source=${source}&granularity=${granularity}`));
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "刷新失败");
    } finally {
      setRefreshing(false);
    }
  }

  function fastScrollTimeline(top: number) {
    const target = messageScrollRef.current;
    if (!target) return;
    if (scrollAnimationRef.current !== null) window.cancelAnimationFrame(scrollAnimationRef.current);
    const destination = Math.max(0, Math.min(top, target.scrollHeight - target.clientHeight));
    const start = target.scrollTop;
    const distance = destination - start;
    if (Math.abs(distance) < 1 || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      target.scrollTop = destination;
      scrollAnimationRef.current = null;
      return;
    }
    const duration = Math.min(180, Math.max(90, Math.abs(distance) / 8));
    const startedAt = window.performance.now();
    const step = (time: number) => {
      const progress = Math.min(1, (time - startedAt) / duration);
      const eased = 1 - Math.pow(1 - progress, 3);
      target.scrollTop = start + distance * eased;
      scrollAnimationRef.current = progress < 1 ? window.requestAnimationFrame(step) : null;
    };
    scrollAnimationRef.current = window.requestAnimationFrame(step);
  }

  function jumpTimeline(edge: "top" | "bottom") {
    const target = messageScrollRef.current;
    if (!target) return;
    fastScrollTimeline(edge === "top" ? 0 : target.scrollHeight);
  }

  function jumpToMessage(messageId: string) {
    const target = messageScrollRef.current;
    const message = document.getElementById(`message-${messageId}`);
    if (!target || !message) return;
    const top = target.scrollTop + message.getBoundingClientRect().top - target.getBoundingClientRect().top - 16;
    fastScrollTimeline(top);
  }

  function showScrollbarWhileScrolling(event: UIEvent<HTMLElement>) {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    target.classList.add("is-scrolling");
    const previousTimer = scrollIdleTimersRef.current.get(target);
    if (previousTimer) window.clearTimeout(previousTimer);
    const timer = window.setTimeout(() => {
      target.classList.remove("is-scrolling");
      scrollIdleTimersRef.current.delete(target);
    }, 650);
    scrollIdleTimersRef.current.set(target, timer);
  }

  async function toggleFavorite() {
    if (!session) return;
    const enabled = !session.favorite;
    await getJson(`/api/favorites/${session.source}/${encodeURIComponent(session.id)}`, { method: enabled ? "PUT" : "DELETE" });
    setSession({ ...session, favorite: enabled });
    await loadSessions();
  }

  function chooseSource(next: Source) {
    setSource(next);
    setWorkspaceFilter("");
    setSelectedKey("");
    setMobileConversationOpen(false);
  }

  function chooseWorkspace(next: string) {
    setWorkspaceFilter(next);
    setSelectedKey("");
    setMobileConversationOpen(false);
  }

  function toggleFavoritesOnly() {
    const enabled = !favoritesOnly;
    setFavoritesOnly(enabled);
    if (!enabled) return;
    setSource("all");
    setWorkspaceFilter("");
    setSelectedKey("");
    setMobileConversationOpen(false);
  }

  return (
    <div className="app-shell" onScrollCapture={showScrollbarWhileScrolling}>
      <header className="topbar">
        <div className="brand-block">
          <button className="mobile-menu" onClick={() => setDrawerOpen(true)} aria-label="打开会话导航">☰</button>
          <span className="brand-mark" aria-hidden="true" />
          <strong className="brand-title">Agent History</strong>
        </div>
        <label className="global-search">
          <span>⌕</span>
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索全部对话、路径或模型…" />
          {query && <button onClick={() => setQuery("")} aria-label="清空搜索">×</button>}
          <kbd>⌘ K</kbd>
        </label>
        <nav className="view-switch" aria-label="主视图">
          <button className={view === "history" ? "active" : ""} onClick={() => setView("history")}>对话</button>
          <button className={view === "stats" ? "active" : ""} onClick={() => setView("stats")}>统计</button>
        </nav>
        <button className="icon-button" onClick={() => setTheme(theme === "light" ? "dark" : "light")} aria-label="切换深浅色">{theme === "light" ? "◐" : "○"}</button>
        <button className={`icon-button refresh-button ${refreshing ? "refreshing" : ""}`} onClick={() => void refresh()} aria-label={refreshing ? "正在刷新历史" : "刷新历史和当前会话"} title={refreshing ? "正在刷新…" : "刷新历史和当前会话"} disabled={refreshing}>↻</button>
      </header>

      {error && <div className="error-toast"><span>!</span>{error}<button onClick={() => setError("")}>×</button></div>}

      <div className="workspace">
        <aside className={`sidebar ${drawerOpen ? "open" : ""}`}>
          <div className="sidebar-mobile-head"><strong>会话导航</strong><button onClick={() => setDrawerOpen(false)}>×</button></div>
          <div className="sidebar-scroll">
            <section className="source-section">
              <p className="section-label">来源筛选</p>
              <button aria-pressed={source === "all"} className={source === "all" ? "active" : ""} onClick={() => chooseSource("all")}><span className="all-mark">∞</span>全部来源<em>{sourceTotals.all}</em></button>
              {(!favoritesOnly || sourceTotals.codex > 0) && <button aria-pressed={source === "codex"} className={source === "codex" ? "active" : ""} onClick={() => chooseSource("codex")}><SourceMark source="codex" />Codex<em>{sourceTotals.codex}</em></button>}
              {(!favoritesOnly || sourceTotals.claude > 0) && <button aria-pressed={source === "claude"} className={source === "claude" ? "active" : ""} onClick={() => chooseSource("claude")}><SourceMark source="claude" />Claude Code<em>{sourceTotals.claude}</em></button>}
            </section>

            <section className="workspace-section">
              <div className="section-title"><p className="section-label">工作区筛选</p><span>{workspaces.length}</span></div>
              <button aria-pressed={!workspaceFilter} className={!workspaceFilter ? "active" : ""} onClick={() => chooseWorkspace("")}><span>▦</span><span>所有工作区</span></button>
              {workspaces.map((item) => (
                <button aria-pressed={workspaceFilter === item.name} key={item.name} className={workspaceFilter === item.name ? "active" : ""} onClick={() => chooseWorkspace(item.name)} title={item.name}>
                  <span className="folder">⌑</span>
                  <span className="workspace-copy"><strong>{shortProject(item.name)}</strong><small>{workspaceParent(item.name)}</small></span>
                  <em>{item.count}</em>
                </button>
              ))}
            </section>
          </div>

          <section className="favorite-section">
            <button className="favorite-switch" role="switch" aria-checked={favoritesOnly} onClick={toggleFavoritesOnly}>
              <span className="favorite-switch-copy"><strong>仅显示收藏</strong><small>{favoriteCount} 个收藏会话</small></span>
              <span className="switch-track" aria-hidden="true"><span className="switch-thumb" /></span>
            </button>
          </section>
        </aside>
        {drawerOpen && <button className="drawer-backdrop" onClick={() => setDrawerOpen(false)} aria-label="关闭导航" />}

        <section className="session-list">
          <header>
            <div><h2>{workspaceFilter ? shortProject(workspaceFilter) : favoritesOnly ? source === "all" ? "收藏会话" : `${sourceLabel(source)} 收藏` : sourceLabel(source)}</h2><span>{total} 个会话</span></div>
          </header>
          <div className="session-scroll">
            {loadingList && sessions.length === 0 ? Array.from({ length: 6 }, (_, index) => <div className="session-skeleton" key={index} />) : null}
            {!loadingList && sessions.length === 0 ? <EmptyState icon="⌕" title={favoritesOnly ? "没有符合条件的收藏会话" : "没有找到会话"} detail={favoritesOnly ? "可以关闭收藏筛选，或收藏更多会话。" : "试试清除搜索或切换数据源。"} /> : null}
            {sessions.map((item) => {
              const key = `${item.source}:${item.id}`;
              return (
                <button className={`session-item ${selectedKey === key ? "active" : ""}`} key={key} onClick={() => { setSelectedKey(key); setDrawerOpen(false); setMobileConversationOpen(true); }}>
                  <span className={`session-source-line ${item.source}`} />
                  <div className="session-row"><SourceMark source={item.source} /><time>{formatDate(item.updatedAt)}</time>{item.favorite && <span className="item-star">★</span>}</div>
                  <strong>{item.title}</strong>
                  <p>{item.match || item.snippet || "无摘要"}</p>
                  <div className="session-meta"><span>{item.messageCount} 条消息</span><span>{formatNumber(item.tokens.total)} tokens</span>{item.toolCount > 0 && <span>{item.toolCount} 工具</span>}</div>
                </button>
              );
            })}
          </div>
        </section>

        {view === "stats" ? (
          <main className="stats-view">
            <header className="stats-header">
              <div><p className="eyebrow">ACTIVITY OVERVIEW</p><h1>使用统计</h1><p>从本机历史归纳你的 Agent 工作节奏。</p></div>
              <div className="granularity">
                {["day", "month", "year"].map((item) => <button key={item} onClick={() => setGranularity(item)} className={granularity === item ? "active" : ""}>{item === "day" ? "按天" : item === "month" ? "按月" : "按年"}</button>)}
              </div>
            </header>
            {!stats ? <div className="stats-loading">正在整理活动数据…</div> : (
              <div className="stats-grid">
                <section className="metric-card primary"><small>全部会话</small><strong>{fullNumber.format(stats.totals.sessions)}</strong><span>Codex {stats.sources.codex} · Claude {stats.sources.claude}</span></section>
                <section className="metric-card"><small>消息总数</small><strong>{formatNumber(stats.totals.messages)}</strong><span>平均 {stats.totals.sessions ? Math.round(stats.totals.messages / stats.totals.sessions) : 0} 条 / 会话</span></section>
                <section className="metric-card"><small>Token 总量</small><strong>{formatNumber(stats.totals.tokens)}</strong><span>输出 {formatNumber(stats.totals.output)}</span></section>
                <section className="metric-card"><small>工具调用</small><strong>{formatNumber(stats.totals.tools)}</strong><span>跨全部时间线</span></section>
                <section className="chart-card wide"><header><div><small>TOKEN TREND</small><h3>Token 使用趋势</h3></div><span>输入 {formatNumber(stats.totals.input)} · 缓存 {formatNumber(stats.totals.cached)}</span></header><TimelineChart data={stats.timeline} /></section>
                <section className="chart-card heat-card"><header><div><small>16 WEEKS</small><h3>活动热力图</h3></div></header><Heatmap data={stats.heatmap} /><div className="heat-legend"><span>少</span>{[0, 1, 2, 3, 4].map((level) => <i className={`level-${level}`} key={level} />)}<span>多</span></div></section>
                <section className="chart-card model-card">
                  <header><div><small>MODELS</small><h3>常用模型</h3></div><span>按 Token 用量排序</span></header>
                  <div className="model-list">
                    {stats.models.slice(0, 6).map((item) => (
                      <div className="model-row" key={item.name}>
                        <span className="model-name" title={item.name}>{item.name}</span>
                        <span className="model-token-bar" role="progressbar" aria-label={`${item.name} Token 用量`} aria-valuemin={0} aria-valuemax={maxModelTokens} aria-valuenow={item.tokens} title={`${fullNumber.format(item.tokens)} tokens`}>
                          <i style={{ width: `${(item.tokens / maxModelTokens) * 100}%` }} />
                        </span>
                        <span className="model-usage"><strong>{formatNumber(item.tokens)} tokens</strong><small>{item.count} 个会话</small></span>
                      </div>
                    ))}
                  </div>
                </section>
              </div>
            )}
          </main>
        ) : (
          <main className={`conversation ${mobileConversationOpen ? "mobile-active" : ""}`}>
            {!selectedKey && !loadingSession ? <EmptyState icon="⌁" title="选择一个会话" detail="从左侧选择 Codex 或 Claude Code 历史记录。" /> : null}
            {loadingSession ? <div className="conversation-loading"><span /><span /><span /></div> : null}
            {session && !loadingSession ? (
              <>
                <header className="conversation-header">
                  <div className="conversation-title-row">
                    <button className="mobile-back" onClick={() => setMobileConversationOpen(false)} aria-label="返回会话列表">‹</button>
                    <SourceMark source={session.source} />
                    <div className="conversation-heading">
                      <div className="conversation-identity" aria-label="会话信息">
                        <span className="identity-item workspace" title={session.cwd || session.project}>
                          <b>工作区</b><span>{session.cwd || session.project || "未知"}</span>
                        </span>
                        <span className="identity-item">
                          <b>创建时间</b><time dateTime={session.startedAt || undefined}>{formatTimestamp(session.startedAt)}</time>
                        </span>
                        <span className="identity-item">
                          <b>更新时间</b><time dateTime={session.updatedAt || undefined}>{formatTimestamp(session.updatedAt)}</time>
                        </span>
                      </div>
                      <h1>{session.title}</h1>
                    </div>
                  </div>
                  <div className="conversation-actions">
                    <button className={session.favorite ? "favorite active" : "favorite"} onClick={() => void toggleFavorite()} title="收藏会话">{session.favorite ? "★" : "☆"}</button>
                    <a href={`/api/export/${session.source}/${encodeURIComponent(session.id)}?format=md`} className="action-button">导出 MD</a>
                    <details className="more-menu"><summary>•••</summary><div><a href={`/api/export/${session.source}/${encodeURIComponent(session.id)}?format=html`}>导出 HTML</a><button onClick={() => navigator.clipboard?.writeText(window.location.href)}>复制页面链接</button></div></details>
                  </div>
                  <div className="conversation-facts">
                    <span>{session.model || "未知模型"}</span><span>{session.messageCount} 条消息</span><span>{formatNumber(session.tokens.total)} tokens</span><span>{session.toolCount} 次工具调用</span><span className="session-id-fact" title={session.id}>session_id: {session.id}</span>
                  </div>
                </header>
                <div className="conversation-tools">
                  <label><span>⌕</span><input value={sessionQuery} onChange={(event) => setSessionQuery(event.target.value)} placeholder="在当前会话中搜索" />{sessionQuery && <button onClick={() => setSessionQuery("")}>×</button>}</label>
                  <div className="filter-buttons"><button className={questionsOnly ? "active" : ""} onClick={() => setQuestionsOnly((value) => !value)}>只看提问</button><button className={!showReasoning ? "active" : ""} onClick={() => setShowReasoning((value) => !value)}>{showReasoning ? "隐藏思考" : "显示思考"}</button></div>
                </div>
                <div className="message-scroll" ref={messageScrollRef}>
                  {timelineItems.length ? timelineItems.map((item) => item.type === "tool-group"
                    ? <ToolCallGroup key={item.key} messages={item.messages!} query={sessionQuery} />
                    : <MessageCard key={item.key} message={item.message!} query={sessionQuery} fallbackModel={session.model} />
                  ) : <EmptyState icon="⌕" title="没有匹配消息" detail="换一个关键词或关闭当前筛选。" />}
                  <div className="timeline-end"><span>时间线结束</span></div>
                </div>
                <nav className="timeline-jump" aria-label="快速浏览当前会话">
                  <button onClick={() => jumpTimeline("top")} title="到达会话顶部"><span aria-hidden="true">↑</span><small>顶部</small></button>
                  <button onClick={() => jumpTimeline("bottom")} title="到达会话底部"><span aria-hidden="true">↓</span><small>底部</small></button>
                </nav>
              </>
            ) : null}
          </main>
        )}

        {view === "history" && session && (
          <aside className="outline">
            <header><p className="section-label">对话大纲</p><span>{questions.length}</span></header>
            <nav>
              {questions.map((item, index) => (
                <a key={item.id} href={`#message-${item.id}`} onClick={(event) => { event.preventDefault(); jumpToMessage(item.id); }}><span>{String(index + 1).padStart(2, "0")}</span><p>{item.text.replace(/\s+/g, " ").slice(0, 72)}</p></a>
              ))}
            </nav>
            <div className="token-breakdown">
              <p className="section-label">TOKEN 构成</p>
              <div><span style={{ width: `${Math.max(2, (session.tokens.input / Math.max(1, session.tokens.total)) * 100)}%` }} /><i style={{ width: `${(session.tokens.output / Math.max(1, session.tokens.total)) * 100}%` }} /></div>
              <dl><dt><b className="input-dot" />输入</dt><dd>{formatNumber(session.tokens.input)}</dd><dt><b className="output-dot" />输出</dt><dd>{formatNumber(session.tokens.output)}</dd><dt><b className="cache-dot" />缓存</dt><dd>{formatNumber(session.tokens.cached)}</dd></dl>
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}
