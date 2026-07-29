import { createHash, randomUUID } from "node:crypto";
import {
  access,
  mkdir,
  readFile,
  readdir,
  rename,
  stat,
  unlink,
  utimes,
  writeFile,
  copyFile,
} from "node:fs/promises";
import path from "node:path";
import { strFromU8, strToU8, unzip, zip } from "fflate";

export const PORTABLE_FORMAT = "agenthistory-session";
export const PORTABLE_VERSION = 1;
export const DEFAULT_ARCHIVE_LIMIT = 512 * 1024 * 1024;
const MAX_ENTRY_COUNT = 2_000;
const MAX_UNCOMPRESSED_BYTES = 1024 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class PortableSessionError extends Error {
  constructor(message, { code = "INVALID_ARCHIVE", status = 400, details } = {}) {
    super(message);
    this.name = "PortableSessionError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

function toArchivePath(...parts) {
  return parts
    .flatMap((part) => String(part).replaceAll("\\", "/").split("/"))
    .filter((part) => part && part !== ".")
    .join("/");
}

function isSafeRelative(value) {
  if (typeof value !== "string" || !value || value.includes("\0")) return false;
  const normalized = value.replaceAll("\\", "/");
  if (normalized.startsWith("/") || /^[a-z]:\//i.test(normalized)) return false;
  return normalized.split("/").every((part) => part && part !== "." && part !== "..");
}

function resolveInside(root, relative) {
  if (!isSafeRelative(relative)) {
    throw new PortableSessionError(`压缩包包含不安全路径：${relative}`, { code: "UNSAFE_PATH" });
  }
  const target = path.resolve(root, ...relative.replaceAll("\\", "/").split("/"));
  const resolvedRoot = path.resolve(root);
  if (target !== resolvedRoot && !target.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new PortableSessionError(`目标路径越界：${relative}`, { code: "UNSAFE_PATH" });
  }
  return target;
}

async function exists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function moveFile(source, target) {
  try {
    await rename(source, target);
  } catch (error) {
    if (error?.code !== "EXDEV") throw error;
    await copyFile(source, target);
    await unlink(source);
  }
}

async function listRegularFiles(root) {
  const output = [];
  async function visit(directory) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    await Promise.all(entries.map(async (entry) => {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(target);
      } else if (entry.isFile()) {
        output.push(target);
      }
    }));
  }
  await visit(root);
  return output.sort();
}

function zipAsync(entries) {
  return new Promise((resolve, reject) => {
    zip(entries, { level: 6 }, (error, data) => error ? reject(error) : resolve(Buffer.from(data)));
  });
}

function unzipAsync(data) {
  let count = 0;
  let total = 0;
  return new Promise((resolve, reject) => {
    try {
      unzip(
        new Uint8Array(data),
        {
          filter(file) {
            count += 1;
            total += file.originalSize;
            if (count > MAX_ENTRY_COUNT) {
              throw new PortableSessionError("压缩包文件数量超过安全上限", { code: "ARCHIVE_TOO_LARGE" });
            }
            if (total > MAX_UNCOMPRESSED_BYTES) {
              throw new PortableSessionError("压缩包解压后体积超过安全上限", { code: "ARCHIVE_TOO_LARGE" });
            }
            if (!isSafeRelative(file.name)) {
              throw new PortableSessionError(`压缩包包含不安全路径：${file.name}`, { code: "UNSAFE_PATH" });
            }
            return true;
          },
        },
        (error, files) => error ? reject(error) : resolve(files),
      );
    } catch (error) {
      reject(error);
    }
  });
}

function portableRoot(source, rootKind, roots) {
  if (source === "codex" && rootKind === "sessions") return roots.codex;
  if (source === "claude" && rootKind === "projects") return roots.claude;
  if (source === "claude" && rootKind === "file-history") {
    return path.join(path.dirname(roots.claude), "file-history");
  }
  throw new PortableSessionError(`不支持的文件根目录：${source}/${rootKind}`, { code: "INVALID_MANIFEST" });
}

function portablePrefix(source, rootKind) {
  return `payload/${source}/${rootKind}`;
}

function validateManifest(manifest) {
  if (!manifest || manifest.format !== PORTABLE_FORMAT || manifest.version !== PORTABLE_VERSION) {
    throw new PortableSessionError("这不是受支持的 AgentHistory 会话包", { code: "UNSUPPORTED_FORMAT" });
  }
  if (!["codex", "claude"].includes(manifest.source)) {
    throw new PortableSessionError("会话来源不受支持", { code: "INVALID_MANIFEST" });
  }
  if (!UUID_PATTERN.test(manifest.sessionId ?? "")) {
    throw new PortableSessionError("清单中的 session ID 无效", { code: "INVALID_MANIFEST" });
  }
  if (typeof manifest.originalWorkspace !== "string" || manifest.originalWorkspace.length > 32_768) {
    throw new PortableSessionError("清单中的原工作区无效", { code: "INVALID_MANIFEST" });
  }
  if (manifest.title != null && (typeof manifest.title !== "string" || manifest.title.length > 32_768)) {
    throw new PortableSessionError("清单中的会话标题无效", { code: "INVALID_MANIFEST" });
  }
  if (!Array.isArray(manifest.files) || manifest.files.length === 0 || manifest.files.length > MAX_ENTRY_COUNT) {
    throw new PortableSessionError("清单没有包含有效的会话文件", { code: "INVALID_MANIFEST" });
  }
  const archivePaths = new Set();
  let mainCount = 0;
  for (const file of manifest.files) {
    if (!file || !isSafeRelative(file.archivePath) || !isSafeRelative(file.relativePath)) {
      throw new PortableSessionError("清单包含不安全的文件路径", { code: "UNSAFE_PATH" });
    }
    if (archivePaths.has(file.archivePath)) {
      throw new PortableSessionError("清单包含重复文件", { code: "INVALID_MANIFEST" });
    }
    archivePaths.add(file.archivePath);
    if (!["main", "subagent", "attachment", "checkpoint"].includes(file.role)) {
      throw new PortableSessionError("清单包含未知文件角色", { code: "INVALID_MANIFEST" });
    }
    if (!/^[0-9a-f]{64}$/i.test(file.sha256 ?? "") || !Number.isSafeInteger(file.size) || file.size < 0) {
      throw new PortableSessionError("清单文件校验信息无效", { code: "INVALID_MANIFEST" });
    }
    portableRoot(manifest.source, file.root, { codex: "/", claude: "/" });
    if (file.role === "main") mainCount += 1;
  }
  if (mainCount !== 1) {
    throw new PortableSessionError("会话包必须且只能包含一个主会话文件", { code: "INVALID_MANIFEST" });
  }
  return manifest;
}

async function readAndValidateArchive(buffer) {
  const files = await unzipAsync(buffer);
  const manifestData = files["manifest.json"];
  if (!manifestData || manifestData.byteLength > MAX_MANIFEST_BYTES) {
    throw new PortableSessionError("压缩包缺少有效的 manifest.json", { code: "INVALID_MANIFEST" });
  }
  let manifest;
  try {
    manifest = JSON.parse(strFromU8(manifestData));
  } catch {
    throw new PortableSessionError("manifest.json 无法解析", { code: "INVALID_MANIFEST" });
  }
  validateManifest(manifest);
  const validatedFiles = {};
  for (const item of manifest.files) {
    const data = files[item.archivePath];
    if (!data || data.byteLength !== item.size || sha256(data) !== item.sha256) {
      throw new PortableSessionError(`文件校验失败：${item.archivePath}`, { code: "CHECKSUM_MISMATCH" });
    }
    validatedFiles[item.archivePath] = data;
  }
  return { manifest, files: validatedFiles };
}

function replaceWorkspaceInTranscript(data, source, originalWorkspace, targetWorkspace) {
  const text = strFromU8(data);
  const trailingNewline = text.endsWith("\n");
  const rows = text.split("\n");
  const mapped = rows.map((line) => {
    if (!line) return line;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      return line;
    }
    if (source === "codex" && ["session_meta", "turn_context"].includes(row.type)) {
      if (row.payload?.cwd === originalWorkspace) row.payload.cwd = targetWorkspace;
    }
    if (source === "claude" && row.cwd === originalWorkspace) row.cwd = targetWorkspace;
    return JSON.stringify(row);
  }).join("\n");
  return strToU8(trailingNewline && !mapped.endsWith("\n") ? `${mapped}\n` : mapped);
}

function encodeClaudeProjectPath(workspace) {
  return workspace.replaceAll("\\", "-").replaceAll("/", "-").replaceAll(":", "-");
}

function shellQuote(value) {
  if (process.platform === "win32") return `"${String(value).replaceAll('"', '""')}"`;
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function resumeDetails(source, sessionId, workspace) {
  if (process.platform === "win32") {
    const command = source === "codex"
      ? `codex -C ${shellQuote(workspace)} resume ${sessionId}`
      : `Set-Location -LiteralPath ${shellQuote(workspace)}; claude --resume ${sessionId}`;
    return { command, workspace, note: source === "codex" ? "Codex 桌面端列表为尽力同步；可使用此命令直接恢复。" : null };
  }
  const command = source === "codex"
    ? `codex -C ${shellQuote(workspace)} resume ${sessionId}`
    : `cd ${shellQuote(workspace)} && claude --resume ${sessionId}`;
  return { command, workspace, note: source === "codex" ? "Codex 桌面端列表为尽力同步；可使用此命令直接恢复。" : null };
}

async function collectCodexFiles(store, session) {
  const selectedIds = new Set([session.id]);
  const rawSessions = [];
  for (const key of store.files.keys()) {
    if (!key.startsWith("codex:")) continue;
    const parsed = await store.load(key);
    if (parsed) rawSessions.push(parsed);
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const candidate of rawSessions) {
      if (!candidate.parentSessionId || !selectedIds.has(candidate.parentSessionId) || selectedIds.has(candidate.id)) continue;
      selectedIds.add(candidate.id);
      changed = true;
    }
  }
  return [...selectedIds].map((id) => {
    const file = store.files.get(`codex:${id}`);
    if (!file) return null;
    return {
      sourcePath: file.path,
      root: "sessions",
      relativePath: toArchivePath(path.relative(store.roots.codex, file.path)),
      role: id === session.id ? "main" : "subagent",
      sessionId: id,
    };
  }).filter(Boolean);
}

async function collectClaudeFiles(store, session) {
  const main = store.files.get(`claude:${session.id}`);
  if (!main) return [];
  const output = [{
    sourcePath: main.path,
    root: "projects",
    relativePath: toArchivePath(path.relative(store.roots.claude, main.path)),
    role: "main",
    sessionId: session.id,
  }];
  const associatedDirectory = path.join(path.dirname(main.path), session.id);
  for (const file of await listRegularFiles(associatedDirectory)) {
    output.push({
      sourcePath: file,
      root: "projects",
      relativePath: toArchivePath(path.relative(store.roots.claude, file)),
      role: file.endsWith(".jsonl") ? "subagent" : "attachment",
      sessionId: path.basename(file).match(/[0-9a-f-]{36}/i)?.[0] ?? session.id,
    });
  }
  const checkpointRoot = path.join(path.dirname(store.roots.claude), "file-history", session.id);
  for (const file of await listRegularFiles(checkpointRoot)) {
    output.push({
      sourcePath: file,
      root: "file-history",
      relativePath: toArchivePath(path.relative(path.join(path.dirname(store.roots.claude), "file-history"), file)),
      role: "checkpoint",
      sessionId: session.id,
    });
  }
  return output;
}

export async function createPortableSession(store, source, sessionId) {
  const session = await store.get(source, sessionId);
  if (!session) return null;
  const collected = source === "codex"
    ? await collectCodexFiles(store, session)
    : await collectClaudeFiles(store, session);
  const zipEntries = {};
  const manifestFiles = [];
  for (const item of collected) {
    const data = await readFile(item.sourcePath);
    const archivePath = toArchivePath(portablePrefix(source, item.root), item.relativePath);
    const info = await stat(item.sourcePath);
    zipEntries[archivePath] = [new Uint8Array(data), { mtime: info.mtime }];
    manifestFiles.push({
      archivePath,
      root: item.root,
      relativePath: item.relativePath,
      role: item.role,
      sessionId: item.sessionId,
      size: data.byteLength,
      sha256: sha256(data),
      modifiedAt: info.mtime.toISOString(),
    });
  }
  const manifest = {
    format: PORTABLE_FORMAT,
    version: PORTABLE_VERSION,
    exportedAt: new Date().toISOString(),
    source,
    sessionId,
    title: session.title,
    originalWorkspace: session.cwd || session.project,
    startedAt: session.startedAt,
    updatedAt: session.updatedAt,
    model: session.model,
    sessionIds: [...new Set(manifestFiles.map((file) => file.sessionId).filter((id) => UUID_PATTERN.test(id)))],
    files: manifestFiles,
    importBehavior: {
      preservesOriginalFiles: true,
      codexDesktopIndex: source === "codex" ? "best-effort-jsonl-only" : null,
    },
  };
  zipEntries["manifest.json"] = [strToU8(`${JSON.stringify(manifest, null, 2)}\n`), { level: 0 }];
  const body = await zipAsync(zipEntries);
  return {
    body,
    extension: "agenthistory.zip",
    contentType: "application/zip",
    manifest,
  };
}

function findConflicts(store, manifest) {
  const ids = new Set([manifest.sessionId, ...(manifest.sessionIds ?? [])]);
  return [...ids].flatMap((id) => {
    const file = store.files.get(`${manifest.source}:${id}`);
    return file ? [{ sessionId: id, path: file.path, main: id === manifest.sessionId }] : [];
  });
}

function portablePreview(store, manifest) {
  const conflicts = findConflicts(store, manifest);
  return {
    format: manifest.format,
    version: manifest.version,
    source: manifest.source,
    sessionId: manifest.sessionId,
    title: manifest.title,
    originalWorkspace: manifest.originalWorkspace,
    startedAt: manifest.startedAt,
    updatedAt: manifest.updatedAt,
    model: manifest.model,
    fileCount: manifest.files.length,
    totalBytes: manifest.files.reduce((sum, file) => sum + file.size, 0),
    subagentCount: manifest.files.filter((file) => file.role === "subagent").length,
    checkpointCount: manifest.files.filter((file) => file.role === "checkpoint").length,
    conflict: conflicts.some((item) => item.main),
    conflicts,
  };
}

export async function preparePortableSession(store, buffer) {
  const validated = await readAndValidateArchive(buffer);
  return {
    preview: portablePreview(store, validated.manifest),
    validated,
  };
}

export async function inspectPortableSession(store, buffer) {
  return (await preparePortableSession(store, buffer)).preview;
}

function mappedRelativePath(manifest, item, targetWorkspace) {
  if (manifest.source !== "claude" || item.root !== "projects") return item.relativePath;
  const main = manifest.files.find((file) => file.role === "main");
  const mainParts = main.relativePath.split("/");
  const originalProjectDirectory = mainParts.length > 1 ? mainParts[0] : null;
  const parts = item.relativePath.split("/");
  if (!originalProjectDirectory) {
    parts.unshift(encodeClaudeProjectPath(targetWorkspace));
  } else if (parts[0] === originalProjectDirectory) {
    parts[0] = encodeClaudeProjectPath(targetWorkspace);
  }
  return parts.join("/");
}

async function updateCodexTextIndex(store, manifest) {
  const indexPath = path.join(path.dirname(store.roots.codex), "session_index.jsonl");
  let rows = [];
  try {
    rows = (await readFile(indexPath, "utf8")).split("\n").filter(Boolean);
  } catch {
    // A fresh Codex profile may not have created its text index yet.
  }
  const retained = rows.filter((line) => {
    try {
      return JSON.parse(line).id !== manifest.sessionId;
    } catch {
      return true;
    }
  });
  retained.push(JSON.stringify({
    id: manifest.sessionId,
    thread_name: manifest.title || `Imported ${manifest.sessionId}`,
    updated_at: manifest.updatedAt || new Date().toISOString(),
  }));
  await mkdir(path.dirname(indexPath), { recursive: true });
  const temporary = `${indexPath}.agenthistory-${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${retained.join("\n")}\n`, { mode: 0o600 });
    await moveFile(temporary, indexPath);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

export async function importValidatedPortableSession(store, validated, options = {}) {
  const { manifest, files } = validated;
  const mode = options.mode === "mapped" ? "mapped" : "original";
  const targetWorkspace = mode === "mapped" ? String(options.workspace ?? "").trim() : manifest.originalWorkspace;
  if (mode === "mapped" && (!targetWorkspace || !path.isAbsolute(targetWorkspace))) {
    throw new PortableSessionError("映射工作区必须是本机绝对路径", { code: "INVALID_WORKSPACE" });
  }
  const conflicts = findConflicts(store, manifest);
  if (conflicts.length && options.overwrite !== true) {
    throw new PortableSessionError("本机已存在相同 session ID，需要确认后才能覆盖", {
      code: "SESSION_CONFLICT",
      status: 409,
      details: { conflicts },
    });
  }

  const operationId = `${new Date().toISOString().replaceAll(/[:.]/g, "-")}-${manifest.sessionId}`;
  const backupRoot = path.join(store.stateDir, "import-backups", operationId);
  const mappedFiles = manifest.files.map((item) => {
    const root = portableRoot(manifest.source, item.root, store.roots);
    const relativePath = mappedRelativePath(manifest, item, targetWorkspace);
    return { item, root, relativePath, target: resolveInside(root, relativePath) };
  });
  const targets = new Set();
  for (const { target } of mappedFiles) {
    if (targets.has(target)) {
      throw new PortableSessionError("导入文件映射到了重复目标", { code: "INVALID_MANIFEST" });
    }
    targets.add(target);
  }
  const targetConflicts = (await Promise.all(mappedFiles.map(async ({ target }) => await exists(target) ? target : null)))
    .filter(Boolean);
  if (targetConflicts.length && options.overwrite !== true) {
    throw new PortableSessionError("目标位置已存在会话文件，需要确认后才能覆盖", {
      code: "SESSION_CONFLICT",
      status: 409,
      details: { conflicts: targetConflicts.map((target) => ({ path: target, target: true })) },
    });
  }
  const staged = [];
  try {
    for (const { item, root, relativePath, target } of mappedFiles) {
      let data = files[item.archivePath];
      if (mode === "mapped" && item.relativePath.endsWith(".jsonl")) {
        data = replaceWorkspaceInTranscript(data, manifest.source, manifest.originalWorkspace, targetWorkspace);
      }
      const temporary = `${target}.agenthistory-${randomUUID()}.tmp`;
      await mkdir(path.dirname(temporary), { recursive: true });
      await writeFile(temporary, data, { mode: 0o600 });
      staged.push({ target, temporary, root, relativePath, modifiedAt: item.modifiedAt });
    }
  } catch (error) {
    await Promise.all(staged.map((item) => unlink(item.temporary).catch(() => {})));
    throw error;
  }

  const existingPaths = new Set([
    ...conflicts.map((conflict) => conflict.path),
    ...targetConflicts,
  ]);
  const backups = [];
  try {
    for (const existingPath of existingPaths) {
      const matchingRoot = [
        store.roots.codex,
        store.roots.claude,
        path.join(path.dirname(store.roots.claude), "file-history"),
      ].find((root) => {
        const resolvedRoot = path.resolve(root);
        const resolvedFile = path.resolve(existingPath);
        return resolvedFile === resolvedRoot || resolvedFile.startsWith(`${resolvedRoot}${path.sep}`);
      });
      if (!matchingRoot || !(await exists(existingPath))) continue;
      const backupPath = resolveInside(
        backupRoot,
        toArchivePath(path.basename(matchingRoot), path.relative(matchingRoot, existingPath)),
      );
      await mkdir(path.dirname(backupPath), { recursive: true });
      await moveFile(existingPath, backupPath);
      backups.push({ original: existingPath, backup: backupPath });
    }
    for (const item of staged) {
      await moveFile(item.temporary, item.target);
      const modifiedAt = new Date(item.modifiedAt ?? "");
      if (!Number.isNaN(modifiedAt.getTime())) await utimes(item.target, modifiedAt, modifiedAt);
    }
    if (manifest.source === "codex") await updateCodexTextIndex(store, manifest);
  } catch (error) {
    for (const item of staged) {
      if (await exists(item.target)) await unlink(item.target).catch(() => {});
      if (await exists(item.temporary)) await unlink(item.temporary).catch(() => {});
    }
    for (const backup of backups.reverse()) {
      await mkdir(path.dirname(backup.original), { recursive: true });
      await moveFile(backup.backup, backup.original).catch(() => {});
    }
    throw error;
  }

  await store.refresh();
  const imported = await store.get(manifest.source, manifest.sessionId);
  if (!imported) {
    throw new PortableSessionError("文件已经写入，但刷新后未找到主会话", {
      code: "IMPORT_NOT_DISCOVERED",
      status: 500,
    });
  }
  return {
    source: manifest.source,
    sessionId: manifest.sessionId,
    title: imported.title,
    workspace: targetWorkspace,
    mode,
    overwritten: conflicts.length > 0,
    backupPath: backups.length ? backupRoot : null,
    resume: resumeDetails(manifest.source, manifest.sessionId, targetWorkspace),
  };
}

export async function importPortableSession(store, buffer, options = {}) {
  return importValidatedPortableSession(store, await readAndValidateArchive(buffer), options);
}
