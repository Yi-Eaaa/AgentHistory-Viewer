import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const mode = process.argv[2] === "dev" ? "dev" : "start";
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const vinextCli = join(projectRoot, "node_modules", "vinext", "dist", "cli.js");
const children = [];
let shuttingDown = false;
let fileEnv = {};
try {
  fileEnv = Object.fromEntries(
    readFileSync(join(projectRoot, ".env"), "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#") && line.includes("="))
      .map((line) => {
        const index = line.indexOf("=");
        return [line.slice(0, index).trim(), line.slice(index + 1).trim().replace(/^['\"]|['\"]$/g, "")];
      }),
  );
} catch {
  // .env is optional; shell variables still take precedence.
}
const env = { ...fileEnv, ...process.env };
env.UI_ORIGIN ??= "http://localhost:30101";

function launch(command, args, extraEnv = {}) {
  const child = spawn(command, args, {
    stdio: "inherit",
    env: { ...env, ...extraEnv },
    cwd: projectRoot,
  });
  children.push(child);
  child.on("exit", (code) => {
    if (!shuttingDown) shutdown(code ?? 1);
  });
  return child;
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (!child.killed) child.kill("SIGTERM");
  }
  setTimeout(() => process.exit(code), 100).unref();
}

if (!existsSync(vinextCli)) {
  console.error("缺少 vinext 运行文件，请先执行 npm install。");
  process.exit(1);
}

launch(process.execPath, [vinextCli, mode, "--port", "30101"], {
  WRANGLER_LOG_PATH: ".wrangler/wrangler.log",
});
setTimeout(() => launch(process.execPath, [join(projectRoot, "server", "index.mjs")], { NODE_ENV: mode === "dev" ? "development" : "production" }), 350);

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
