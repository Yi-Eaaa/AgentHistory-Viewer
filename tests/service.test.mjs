import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { MACOS_LABEL, renderLaunchAgent, renderSystemdUnit } from "../scripts/service.mjs";

test("macOS LaunchAgent uses absolute paths and escapes plist values", () => {
  const plist = renderLaunchAgent({
    nodePath: "/opt/Node & Tools/bin/node",
    root: "/Users/test/Agent & History",
    stdoutPath: "/tmp/agent.out",
    stderrPath: "/tmp/agent.err",
  });
  assert.match(plist, new RegExp(`<string>${MACOS_LABEL}</string>`));
  assert.match(plist, /\/opt\/Node &amp; Tools\/bin\/node/);
  assert.match(plist, /Agent &amp; History\/scripts\/run\.mjs/);
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(plist, /<key>KeepAlive<\/key>\s*<true\/>/);
});

test("systemd unit runs the project with the current absolute Node binary", () => {
  const unit = renderSystemdUnit({
    nodePath: "/opt/node current/bin/node",
    root: "/srv/agent history%archive",
  });
  assert.match(unit, /WorkingDirectory="\/srv\/agent history%%archive"/);
  assert.match(unit, /ExecStart="\/opt\/node current\/bin\/node" "\/srv\/agent history%%archive\/scripts\/run\.mjs" start/);
  assert.match(unit, /Restart=on-failure/);
  assert.match(unit, /WantedBy=default\.target/);
});

test("Windows installer registers a real SCM service through pinned WinSW", async () => {
  const source = await readFile(new URL("../deploy/windows/service.ps1", import.meta.url), "utf8");
  assert.match(source, /WinSWVersion = "2\.12\.0"/);
  assert.match(source, /winsw\/winsw\/releases\/download/);
  assert.match(source, /Invoke-Wrapper @\("install"\)/);
  assert.match(source, /Invoke-Wrapper @\("start"\)/);
  assert.match(source, /Get-Service -Name \$ServiceName/);
  assert.match(source, /<startmode>Automatic<\/startmode>/);
});

test("service runner invokes vinext directly without relying on npm in service PATH", async () => {
  const source = await readFile(new URL("../scripts/run.mjs", import.meta.url), "utf8");
  assert.match(source, /node_modules", "vinext", "dist", "cli\.js"/);
  assert.doesNotMatch(source, /launch\("npm"/);
  assert.match(source, /cwd: projectRoot/);
});
