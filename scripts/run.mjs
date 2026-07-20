import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

const mode = process.argv[2] === "dev" ? "dev" : "start";
const children = [];
let fileEnv = {};
try {
  fileEnv = Object.fromEntries(
    readFileSync(".env", "utf8")
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
  });
  children.push(child);
  child.on("exit", (code) => {
    if (code && code !== 0) shutdown(code);
  });
  return child;
}

function shutdown(code = 0) {
  for (const child of children) {
    if (!child.killed) child.kill("SIGTERM");
  }
  setTimeout(() => process.exit(code), 100).unref();
}

launch("npm", ["exec", "vinext", mode, "--", "--port", "30101"], {
  WRANGLER_LOG_PATH: ".wrangler/wrangler.log",
});
setTimeout(() => launch(process.execPath, ["server/index.mjs"], { NODE_ENV: mode === "dev" ? "development" : "production" }), 350);

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
