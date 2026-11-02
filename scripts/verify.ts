import { spawn, fork } from "node:child_process";
import { once } from "node:events";
import { join, resolve } from "node:path";
import {
  cpSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { createRequire } from "node:module";
import { createPackageWithOptions } from "@electron/asar";
import { compileEsm } from "./adapt.ts";
import {
  config,
  root,
  run,
  readJson,
  writeJson,
  integrity,
  currentPlatform,
  version,
} from "./common.ts";

const platform = currentPlatform();
const out = resolve(
  process.env.ARTIFACT_DIR || join(root, "dist", platform.id),
);
const build = readJson(join(out, "build.json"));
if (build.platform !== platform.id || build.version !== version)
  throw new Error("Artifact platform/version mismatch");
const mainDir = join(root, "dist/main");
const mainBuild = readJson(join(mainDir, "build.json"));
if (
  mainBuild.buildKey !== build.buildKey ||
  mainBuild.upstream.sha !== build.upstream.sha
)
  throw new Error("JS and native sources differ");
for (const pkg of mainBuild.packages) {
  cpSync(join(mainDir, pkg.filename), join(out, pkg.filename));
  if (!build.packages.some((item) => item.name === pkg.name))
    build.packages.push(pkg);
}
writeJson(join(out, "build.json"), build);
for (const pkg of build.packages)
  if (integrity(join(out, pkg.filename)) !== pkg.integrity)
    throw new Error(`Corrupt tarball ${pkg.filename}`);
const work = join(
  root,
  ".work",
  version,
  "verify",
  platform.id,
  process.env.PROOF_NAME || "verified",
);
mkdirSync(work, { recursive: true });
const server = fork(join(root, "test/registry.ts"), [out], {
  stdio: ["ignore", "inherit", "inherit", "ipc"],
});
const [{ port }] = await once(server, "message");
const registry = `http://127.0.0.1:${port}`;
const results = [];
const runtimeConfig =
  process.env.CURRENT_NODE_ONLY === "1"
    ? { node: [process.versions.node], electron: [] }
    : process.env.RUNTIME_MATRIX
      ? JSON.parse(process.env.RUNTIME_MATRIX)
      : config.runtimes;

function execute(command, args, options = {}) {
  return new Promise<void>((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: work,
      stdio: "inherit",
      ...options,
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Timed out ${command}`));
    }, 180000);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolvePromise();
      else reject(new Error(`${command} exited ${code}`));
    });
  });
}
function project(name) {
  const dir = join(work, name);
  if (existsSync(dir))
    throw new Error(
      `Verification directory already exists: ${dir}. Use a fresh workspace for verification.`,
    );
  mkdirSync(dir, { recursive: true });
  writeJson(join(dir, "package.json"), {
    name: "pty-isolated-smoke",
    version: "1.0.0",
    private: true,
    type: "module",
    main: "smoke.js",
    dependencies: { [config.package]: version },
  });
  writeFileSync(
    join(dir, "smoke.js"),
    compileEsm(readFileSync(join(root, "test/smoke.ts"), "utf8"), "smoke.ts"),
  );
  return dir;
}
try {
  const tools = join(work, "tools");
  mkdirSync(tools, { recursive: true });
  run("npm", [
    "install",
    "--prefix",
    tools,
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    `pnpm@${config.pnpm}`,
  ]);
  for (const manager of ["npm", "pnpm"]) {
    const dir = project(manager);
    const args = ["install", "--ignore-scripts", `--registry=${registry}`];
    if (manager === "npm")
      run("npm", [...args, "--include=optional", "--no-audit", "--no-fund"], {
        cwd: dir,
      });
    else
      run(
        process.execPath,
        [
          join(tools, "node_modules/pnpm/bin/pnpm.cjs"),
          ...args,
          "--store-dir",
          join(work, "pnpm-store"),
        ],
        { cwd: dir },
      );
    const require = createRequire(join(dir, "smoke.js"));
    const installed = require(`${config.package}/package.json`);
    if (
      installed.version !== version ||
      installed.scripts ||
      existsSync(join(dir, "node_modules", config.package, "binding.gyp"))
    )
      throw new Error("Unexpected install script or node-gyp input");
    await execute(process.execPath, [join(dir, "smoke.js")], { cwd: dir });
    await execute(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        "import { spawn } from '@qwqo/node-pty'; if (typeof spawn !== 'function') throw new Error('Missing ESM API')",
      ],
      { cwd: dir },
    );
    cpSync(join(root, "test/types.ts"), join(dir, "types.ts"));
    run(
      process.execPath,
      [
        join(root, "node_modules/typescript/bin/tsc"),
        "--noEmit",
        "--strict",
        "--target",
        "es2022",
        "--module",
        "node16",
        "--moduleResolution",
        "node16",
        "--typeRoots",
        join(root, "node_modules/@types"),
        join(dir, "types.ts"),
      ],
      { cwd: dir },
    );
    results.push({
      kind: "installation",
      manager,
      scripts: false,
      types: true,
      ok: true,
    });
  }
  const omitted = project("omitted");
  run(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--omit=optional",
      "--no-audit",
      "--no-fund",
      `--registry=${registry}`,
    ],
    { cwd: omitted },
  );
  const omitCheck = `try { require('@qwqo/node-pty').spawn(${JSON.stringify(process.platform === "win32" ? "cmd.exe" : "/bin/sh")}, []); process.exit(1); } catch (e) { if (e.code !== 'ERR_PTY_MISSING_PACKAGE') throw e; }`;
  run(process.execPath, ["-e", omitCheck], { cwd: omitted });
  results.push({ kind: "omit-optional", ok: true });
  const dir = join(work, "npm");
  for (const nodeVersion of runtimeConfig.node) {
    if (process.env.CURRENT_NODE_ONLY === "1") {
      await execute(process.execPath, [join(dir, "smoke.js")], { cwd: dir });
      results.push({ kind: "node", version: process.versions.node, ok: true });
      continue;
    }
    const runtime = join(work, `node-${nodeVersion}`);
    run("npm", [
      "install",
      "--prefix",
      runtime,
      "--no-audit",
      "--no-fund",
      `node@${nodeVersion}`,
    ]);
    const binary = join(
      runtime,
      "node_modules/node/bin",
      process.platform === "win32" ? "node.exe" : "node",
    );
    await execute(binary, [join(dir, "smoke.js")], { cwd: dir });
    results.push({ kind: "node", version: nodeVersion, ok: true });
  }
  // A real app.asar plus unpacked full native packages exercises workers and helpers.
  const asar = join(work, "app.asar");
  await createPackageWithOptions(dir, asar, {
    unpackDir: "node_modules/@qwqo{,/**}",
  });
  for (const electronVersion of runtimeConfig.electron) {
    const runtime = join(work, `electron-${electronVersion}`);
    run("npm", [
      "install",
      "--prefix",
      runtime,
      "--no-audit",
      "--no-fund",
      `electron@${electronVersion}`,
    ]);
    const require = createRequire(join(runtime, "package.json"));
    const executable = require("electron");
    const env: NodeJS.ProcessEnv = { ...process.env, EXPECT_ELECTRON: "1" };
    delete env.ELECTRON_RUN_AS_NODE;
    for (const app of [dir, asar]) {
      const args = [app, "--no-sandbox", "--disable-gpu"];
      if (process.platform === "linux")
        await execute("xvfb-run", ["-a", executable, ...args], {
          cwd: dir,
          env,
        });
      else await execute(executable, args, { cwd: dir, env });
      results.push({
        kind: "electron",
        version: electronVersion,
        asar: app === asar,
        ok: true,
      });
    }
  }
  const report = process.report.getReport() as {
    header: { glibcVersionRuntime?: string };
  };
  writeJson(join(out, `${process.env.PROOF_NAME || "verified"}.json`), {
    platform: platform.id,
    version,
    buildKey: build.buildKey,
    packages: build.packages,
    runtimes: runtimeConfig,
    results,
    host: {
      platform: process.platform,
      arch: process.arch,
      glibc: report.header.glibcVersionRuntime,
    },
    testedAt: new Date().toISOString(),
  });
} finally {
  server.kill();
}
