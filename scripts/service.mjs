import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const SERVICE_ID = "agent-history";
export const MACOS_LABEL = "com.agent-history.viewer";
const MACOS_BOOTSTRAP_RETRY_STATUS = 5;
const MACOS_BOOTSTRAP_ATTEMPTS = 5;
const MACOS_UNLOAD_ATTEMPTS = 30;
const MACOS_RETRY_DELAY_MS = 200;

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const stateDir = join(projectRoot, "state");

function xmlEscape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function systemdSpecifierEscape(value) {
  return String(value).replaceAll("%", "%%");
}

function systemdQuote(value) {
  return `"${systemdSpecifierEscape(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

export function renderLaunchAgent({ nodePath, root, stdoutPath, stderrPath }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${MACOS_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(nodePath)}</string>
    <string>${xmlEscape(join(root, "scripts", "run.mjs"))}</string>
    <string>start</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(root)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>NODE_ENV</key>
    <string>production</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>ThrottleInterval</key>
  <integer>5</integer>
  <key>StandardOutPath</key>
  <string>${xmlEscape(stdoutPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(stderrPath)}</string>
</dict>
</plist>
`;
}

export function renderSystemdUnit({ nodePath, root }) {
  return `[Unit]
Description=AgentHistory Viewer local conversation viewer
After=network.target

[Service]
Type=simple
WorkingDirectory=${systemdSpecifierEscape(root)}
ExecStart=${systemdQuote(nodePath)} ${systemdQuote(join(root, "scripts", "run.mjs"))} start
Environment="NODE_ENV=production"
Restart=on-failure
RestartSec=5
TimeoutStopSec=20

[Install]
WantedBy=default.target
`;
}

function run(command, args, { allowFailure = false, quiet = false } = {}) {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    stdio: quiet ? "ignore" : "inherit",
    env: process.env,
  });
  if (result.error) {
    if (allowFailure) return result.status ?? 1;
    throw result.error;
  }
  if (result.status !== 0 && !allowFailure) {
    throw new Error(`${command} 执行失败，退出码 ${result.status}`);
  }
  return result.status ?? 0;
}

function pause(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

export function retryTransientStatus(
  action,
  {
    attempts = MACOS_BOOTSTRAP_ATTEMPTS,
    retryStatuses = [MACOS_BOOTSTRAP_RETRY_STATUS],
    delayMs = MACOS_RETRY_DELAY_MS,
    sleep = pause,
  } = {},
) {
  const totalAttempts = Math.max(1, attempts);
  let status = 1;
  for (let attempt = 0; attempt < totalAttempts; attempt += 1) {
    status = action(attempt, totalAttempts);
    if (status === 0 || !retryStatuses.includes(status) || attempt === totalAttempts - 1) return status;
    sleep(delayMs * (attempt + 1));
  }
  return status;
}

function assertReady() {
  const required = [
    join(projectRoot, "dist", "server", "index.js"),
    join(projectRoot, "node_modules", "vinext", "dist", "cli.js"),
  ];
  const missing = required.filter((file) => !existsSync(file));
  if (missing.length) {
    throw new Error("缺少生产构建或依赖，请先执行 npm install && npm run build。");
  }
}

function macosServiceLoaded(target) {
  return run("launchctl", ["print", target], { allowFailure: true, quiet: true }) === 0;
}

function waitForMacosServiceUnloaded(target) {
  for (let attempt = 0; attempt < MACOS_UNLOAD_ATTEMPTS; attempt += 1) {
    if (!macosServiceLoaded(target)) return;
    pause(MACOS_RETRY_DELAY_MS);
  }
  throw new Error(`旧服务 ${MACOS_LABEL} 未能及时退出，请稍后重试`);
}

function writeMacosServiceFile(serviceFile) {
  mkdirSync(dirname(serviceFile), { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(serviceFile, renderLaunchAgent({
    nodePath: process.execPath,
    root: projectRoot,
    stdoutPath: join(stateDir, "service.stdout.log"),
    stderrPath: join(stateDir, "service.stderr.log"),
  }));
  run("plutil", ["-lint", serviceFile]);
}

function bootstrapMacosService(domain, serviceFile) {
  const status = retryTransientStatus(
    (attempt, attempts) => run(
      "launchctl",
      ["bootstrap", domain, serviceFile],
      { allowFailure: true, quiet: attempt < attempts - 1 },
    ),
  );
  if (status !== 0) throw new Error(`launchctl bootstrap 执行失败，退出码 ${status}`);
}

function loadMacosService(domain, target, serviceFile) {
  writeMacosServiceFile(serviceFile);
  bootstrapMacosService(domain, serviceFile);
  run("launchctl", ["enable", target]);
  run("launchctl", ["kickstart", "-k", target]);
}

function macosService(action) {
  if (typeof process.getuid !== "function") throw new Error("无法取得当前用户 UID。");
  const domain = `gui/${process.getuid()}`;
  const target = `${domain}/${MACOS_LABEL}`;
  const serviceFile = join(homedir(), "Library", "LaunchAgents", `${MACOS_LABEL}.plist`);

  if (action === "install") {
    assertReady();
    run("launchctl", ["bootout", target], { allowFailure: true, quiet: true });
    waitForMacosServiceUnloaded(target);
    loadMacosService(domain, target, serviceFile);
    console.log(`已安装并启动 macOS 用户服务：${MACOS_LABEL}`);
    return;
  }
  if (action === "uninstall") {
    run("launchctl", ["bootout", target], { allowFailure: true, quiet: true });
    rmSync(serviceFile, { force: true });
    console.log(`已卸载 macOS 用户服务：${MACOS_LABEL}`);
    return;
  }
  if (action === "restart") {
    assertReady();
    if (!macosServiceLoaded(target)) {
      console.log(`服务 ${MACOS_LABEL} 尚未注册，正在自动恢复…`);
      loadMacosService(domain, target, serviceFile);
    } else {
      run("launchctl", ["kickstart", "-k", target]);
    }
    return;
  }
  run("launchctl", ["print", target]);
}

function linuxService(action) {
  const unitDir = join(homedir(), ".config", "systemd", "user");
  const unitFile = join(unitDir, `${SERVICE_ID}.service`);

  if (action === "install") {
    assertReady();
    mkdirSync(unitDir, { recursive: true });
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(unitFile, renderSystemdUnit({ nodePath: process.execPath, root: projectRoot }));
    run("systemctl", ["--user", "daemon-reload"]);
    run("systemctl", ["--user", "enable", "--now", `${SERVICE_ID}.service`]);
    console.log(`已安装并启动 systemd 用户服务：${SERVICE_ID}.service`);
    console.log("若需在用户登录前启动，请由管理员执行：loginctl enable-linger <用户名>");
    return;
  }
  if (action === "uninstall") {
    run("systemctl", ["--user", "disable", "--now", `${SERVICE_ID}.service`], { allowFailure: true });
    rmSync(unitFile, { force: true });
    run("systemctl", ["--user", "daemon-reload"]);
    run("systemctl", ["--user", "reset-failed", `${SERVICE_ID}.service`], { allowFailure: true, quiet: true });
    console.log(`已卸载 systemd 用户服务：${SERVICE_ID}.service`);
    return;
  }
  if (action === "restart") {
    assertReady();
    run("systemctl", ["--user", "restart", `${SERVICE_ID}.service`]);
    return;
  }
  run("systemctl", ["--user", "status", "--no-pager", "--full", `${SERVICE_ID}.service`]);
}

function windowsService(action) {
  if (["install", "restart"].includes(action)) assertReady();
  const script = join(projectRoot, "deploy", "windows", "service.ps1");
  const actionName = action[0].toUpperCase() + action.slice(1);
  run("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-File", script,
    "-Action", actionName,
    "-ProjectRoot", projectRoot,
    "-NodePath", process.execPath,
  ]);
}

export function printHelp() {
  console.log(`AgentHistory Viewer 系统服务管理

用法：node scripts/service.mjs <install|uninstall|restart|status>

  install    注册并立即启动当前平台的服务
  uninstall  停止并移除服务
  restart    使用当前构建重新启动服务
  status     查看服务状态`);
}

function main() {
  const action = process.argv[2] ?? "status";
  if (["help", "--help", "-h"].includes(action)) return printHelp();
  if (!["install", "uninstall", "restart", "status"].includes(action)) {
    throw new Error(`未知操作：${action}`);
  }
  if (process.platform === "darwin") return macosService(action);
  if (process.platform === "linux") return linuxService(action);
  if (process.platform === "win32") return windowsService(action);
  throw new Error(`不支持的平台：${process.platform}`);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
