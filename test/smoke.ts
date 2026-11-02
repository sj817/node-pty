import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const pty = require("@qwqo/node-pty");
const manifest = require("@qwqo/node-pty/package.json");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function smoke(options = {}) {
  const win = process.platform === "win32";
  const shell = win
    ? "cmd.exe"
    : process.platform === "android"
      ? "/system/bin/sh"
      : "/bin/sh";
  const child = pty.spawn(shell, win ? ["/d", "/q"] : [], {
    cols: 80,
    rows: 24,
    cwd: process.cwd(),
    env: process.env,
    ...options,
  });
  let output = "";
  child.onData((data) => {
    output += data;
  });
  const exited = new Promise<{ exitCode: number }>((resolve) =>
    child.onExit(resolve),
  );
  const timeout = setTimeout(() => {
    try {
      child.kill();
    } finally {
      console.error(output);
      process.exit(1);
    }
  }, 30000);
  try {
    await delay(300);
    child.resize(103, 37);
    assert.equal(child.cols, 103);
    assert.equal(child.rows, 37);
    // Split the marker so input echo cannot satisfy the output assertion.
    child.write(
      win
        ? "set PTY_FIRST=PTY_\r\necho %PTY_FIRST%SMOKE_OK\r\n"
        : "printf '%s%s\\n' PTY_ SMOKE_OK\n",
    );
    for (let i = 0; i < 200 && !output.includes("PTY_SMOKE_OK"); i++)
      await delay(50);
    assert.match(output, /PTY_SMOKE_OK/);
    if (!win) {
      child.write("stty size\n");
      for (let i = 0; i < 100 && !output.includes("37 103"); i++)
        await delay(50);
      assert.match(output, /37 103/);
    }
    child.write(win ? "exit 7\r\n" : "exit 7\n");
    const exit = await exited;
    assert.equal(exit.exitCode, 7);
    for (let i = 0; i < 100; i++) {
      try {
        process.kill(child.pid, 0);
      } catch (error) {
        if (error.code === "ESRCH") return;
        throw error;
      }
      await delay(50);
    }
    throw new Error(`Shell ${child.pid} survived exit`);
  } finally {
    clearTimeout(timeout);
    try {
      child.kill();
    } catch {
      /* Already exited. */
    }
  }
}

async function cleanup() {
  const win = process.platform === "win32";
  const child = pty.spawn(
    win
      ? "cmd.exe"
      : process.platform === "android"
        ? "/system/bin/sh"
        : "/bin/sh",
    win ? ["/d", "/q"] : [],
    { cols: 80, rows: 24, env: process.env },
  );
  const exited = new Promise((resolve) => child.onExit(resolve));
  child.onData(() => {});
  await delay(500);
  child.kill();
  await Promise.race([
    exited,
    delay(15000).then(() => {
      throw new Error("Missing exit after kill");
    }),
  ]);
  for (let i = 0; i < 100; i++) {
    try {
      process.kill(child.pid, 0);
    } catch (error) {
      if (error.code === "ESRCH") return;
      throw error;
    }
    await delay(50);
  }
  throw new Error(`Killed shell ${child.pid} survived`);
}

async function main() {
  if (process.env.EXPECT_ELECTRON)
    assert.ok(
      process.versions.electron,
      "A real Electron main process is required",
    );
  await smoke();
  if (process.platform === "win32") {
    await smoke({ useConpty: true, useConptyDll: true });
    if (manifest.nodePty.features?.winpty !== false)
      await smoke({ useConpty: false });
  }
  await cleanup();
  console.log(
    JSON.stringify({
      ok: true,
      node: process.versions.node,
      electron: process.versions.electron || null,
      napi: process.versions.napi,
      platform: process.platform,
      arch: process.arch,
    }),
  );
}

if (process.versions.electron && process.env.EXPECT_ELECTRON) {
  const { app } = require("electron");
  app
    .whenReady()
    .then(main)
    .then(
      () => app.exit(0),
      (error) => {
        console.error(error);
        app.exit(1);
      },
    );
} else {
  main().then(
    () => process.exit(0),
    (error) => {
      console.error(error);
      process.exit(1);
    },
  );
}
