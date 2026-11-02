import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { compileEsm } from "./adapt.ts";
import {
  config,
  integrity,
  readJson,
  root,
  run,
  version,
  writeJson,
} from "./common.ts";
import { validateDeviceProof } from "./proof.ts";

const prefix = process.env.ANDROID_NODE_PREFIX;
const serial = process.env.ADB_SERIAL;
if (!prefix || !/^\/[a-zA-Z0-9/_.+-]+$/.test(prefix) || !serial) {
  throw new Error(
    "Set ADB_SERIAL and ANDROID_NODE_PREFIX to the target Android Node installation",
  );
}
const quote = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`;
const environment = `export LD_LIBRARY_PATH=${quote(prefix + "/lib")}; export PATH=${quote(prefix + "/bin:/system/bin:/system/xbin")}; `;
function adb(args: string[], capture = false) {
  return run("adb", ["-s", serial, ...args], { capture });
}
function shell(command: string, capture = false) {
  return adb(["shell", `su -c ${quote(environment + command)}`], capture);
}
const host = JSON.parse(
  shell(
    `node -p ${quote("JSON.stringify({platform:process.platform,arch:process.arch,node:process.versions.node,napi:process.versions.napi})")}`,
    true,
  ),
);
assert.equal(host.platform, "android");
assert.equal(host.arch, "arm64");
host.androidApi = Number(shell("getprop ro.build.version.sdk", true));

const out = join(root, "dist/android-arm64");
const build = readJson(join(out, "build.json"));
const main = readJson(join(root, "dist/main/build.json"));
assert.equal(main.buildKey, build.buildKey);
for (const pkg of main.packages) {
  cpSync(join(root, "dist/main", pkg.filename), join(out, pkg.filename));
  if (!build.packages.some((item) => item.name === pkg.name))
    build.packages.push(pkg);
}
for (const pkg of build.packages)
  assert.equal(integrity(join(out, pkg.filename)), pkg.integrity);
writeJson(join(out, "build.json"), build);
const server = fork(join(root, "test/registry.ts"), [out], {
  stdio: ["ignore", "inherit", "inherit", "ipc"],
});
const [{ port }] = await once(server, "message");
const work = join(root, ".work/android-test");
mkdirSync(work, { recursive: true });
const remote = `/data/local/tmp/qwqo-node-pty-${version}-${Date.now()}`;
const results = [];
try {
  shell(`mkdir -p ${quote(remote)}`);
  adb(["reverse", `tcp:${port}`, `tcp:${port}`]);
  for (const [name, toolVersion] of [
    ["npm", config.publishNpm],
    ["pnpm", config.pnpm],
  ]) {
    const metadata = await (
      await fetch(`https://registry.npmjs.org/${name}/${toolVersion}`)
    ).json();
    const bytes = Buffer.from(
      await (await fetch(metadata.dist.tarball)).arrayBuffer(),
    );
    assert.equal(
      "sha512-" + createHash("sha512").update(bytes).digest("base64"),
      metadata.dist.integrity,
    );
    const archive = join(work, `${name}.tgz`);
    writeFileSync(archive, bytes);
    adb(["push", archive, `${remote}/${name}.tgz`]);
    shell(
      `mkdir -p ${quote(remote + "/tools/" + name)}; tar -xzf ${quote(remote + "/" + name + ".tgz")} -C ${quote(remote + "/tools/" + name)} --strip-components=1`,
    );
  }
  for (const manager of ["npm", "pnpm"]) {
    const local = join(work, manager);
    const project = `${remote}/${manager}`;
    mkdirSync(local, { recursive: true });
    writeJson(join(local, "package.json"), {
      name: "android-pty-test",
      private: true,
      version: "1.0.0",
      type: "module",
      dependencies: { [config.package]: version },
    });
    writeFileSync(
      join(local, "smoke.js"),
      compileEsm(readFileSync(join(root, "test/smoke.ts"), "utf8"), "smoke.ts"),
    );
    adb(["push", local, project]);
    const cli =
      manager === "npm"
        ? `${remote}/tools/npm/bin/npm-cli.js`
        : `${remote}/tools/pnpm/bin/pnpm.cjs`;
    shell(
      `cd ${quote(project)}; node ${quote(cli)} install --ignore-scripts --registry=http://127.0.0.1:${port}`,
    );
    shell(`cd ${quote(project)}; node smoke.js`);
    results.push({ kind: "installation", manager, scripts: false, ok: true });
  }
  results.push({ kind: "node", version: host.node, ok: true });
  const proof = {
    platform: "android-arm64",
    version,
    buildKey: build.buildKey,
    packages: build.packages,
    host,
    runtimes: { node: [host.node], electron: [] },
    results,
    testedAt: new Date().toISOString(),
  };
  validateDeviceProof(proof, {
    version,
    buildKey: build.buildKey,
    packages: build.packages,
  });
  writeJson(join(out, "verified.json"), proof);
  console.log(
    `Android device verification saved to ${join(out, "verified.json")}`,
  );
} finally {
  adb(["reverse", "--remove", `tcp:${port}`]);
  server.kill();
}
