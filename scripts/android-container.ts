import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { compileEsm } from "./adapt.ts";
import {
  config,
  hash,
  integrity,
  readJson,
  root,
  run,
  writeJson,
} from "./common.ts";
import { validateDeviceProof } from "./proof.ts";
import { verificationRecipe } from "./runtimes.ts";

assert.equal(
  process.platform,
  "linux",
  "Android container verification requires a Linux Docker host",
);
assert.equal(
  process.arch,
  "arm64",
  "Use a native ARM64 runner for the Android ARM64 container",
);
const out = join(root, "dist/android-arm64");
const build = readJson(join(out, "build.json"));
const main = readJson(join(root, "dist/main/build.json"));
assert.equal(build.buildKey, main.buildKey);
assert.equal(build.version, main.version);
for (const pkg of main.packages) {
  cpSync(join(root, "dist/main", pkg.filename), join(out, pkg.filename));
  if (!build.packages.some((entry) => entry.name === pkg.name))
    build.packages.push(pkg);
}
for (const pkg of build.packages) {
  assert.equal(pkg.version, build.version);
  assert.equal(integrity(join(out, pkg.filename)), pkg.integrity);
}
writeJson(join(out, "build.json"), build);
const mainPackage = main.packages.find((pkg) => pkg.name === config.package);
const mainManifest = JSON.parse(
  run(
    "tar",
    ["-xOf", join(out, mainPackage.filename), "package/package.json"],
    {
      capture: true,
    },
  ),
);
const packageNames = mainManifest.nodePty.features?.aliasTypes
  ? [config.package, "node-pty"]
  : [config.package];
const cases = ["npm", "pnpm"].flatMap((manager) =>
  packageNames.map((packageName) => ({
    manager,
    packageName,
    name: `${manager}${packageName === config.package ? "" : "-alias"}`,
  })),
);
const parent = join(root, ".work/android-container");
mkdirSync(parent, { recursive: true });
const work = mkdtempSync(join(parent, `${build.version}-`));
chmodSync(work, 0o777);
const runtime = join(work, "runtime");
mkdirSync(runtime);
for (const pkg of config.androidRuntime.packages) {
  const response = await fetch(pkg.url, {
    signal: AbortSignal.timeout(120000),
  });
  assert.equal(response.status, 200, `Android runtime package ${pkg.name}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(hash(bytes), pkg.sha256, `Android runtime checksum ${pkg.name}`);
  const folder = join(work, "debs", pkg.name);
  mkdirSync(folder, { recursive: true });
  const archive = join(folder, "package.deb");
  writeFileSync(archive, bytes);
  run("ar", ["x", archive], { cwd: folder });
  const data = run("ar", ["t", archive], { capture: true })
    .split(/\r?\n/)
    .find((file) => file.startsWith("data.tar"));
  assert.ok(data, `Missing data archive in ${pkg.name}`);
  run("tar", ["-xf", join(folder, data), "-C", runtime]);
}
// Debian archive directories can retain app-private modes under the host UID.
// The container's system user needs to traverse this read-only runtime fixture.
run("chmod", ["-R", "a+rX", runtime]);
for (const [name, version] of [
  ["npm", config.publishNpm],
  ["pnpm", config.pnpm],
]) {
  const metadata = await (
    await fetch(`https://registry.npmjs.org/${name}/${version}`, {
      signal: AbortSignal.timeout(45000),
    })
  ).json();
  const bytes = Buffer.from(
    await (
      await fetch(metadata.dist.tarball, {
        signal: AbortSignal.timeout(120000),
      })
    ).arrayBuffer(),
  );
  assert.equal(
    "sha512-" + createHash("sha512").update(bytes).digest("base64"),
    metadata.dist.integrity,
  );
  const archive = join(work, `${name}.tgz`);
  const target = join(work, "tools", name);
  mkdirSync(target, { recursive: true });
  writeFileSync(archive, bytes);
  run("tar", ["-xzf", archive, "--strip-components=1", "-C", target]);
}
for (const { name, packageName } of cases) {
  const project = join(work, name);
  mkdirSync(project, { mode: 0o777 });
  chmodSync(project, 0o777);
  writeJson(join(project, "package.json"), {
    name: "android-pty-container-test",
    version: "1.0.0",
    private: true,
    type: "module",
    dependencies: {
      [packageName]:
        packageName === config.package
          ? build.version
          : `npm:${config.package}@${build.version}`,
    },
  });
  writeFileSync(
    join(project, "smoke.js"),
    compileEsm(
      readFileSync(join(root, "test/smoke.ts"), "utf8").replaceAll(
        config.package,
        packageName,
      ),
      "smoke.ts",
    ),
  );
  for (const fixture of [
    "types.ts",
    ...(mainManifest.nodePty.features?.aliasTypes ? ["types.cts"] : []),
  ])
    writeFileSync(
      join(project, fixture),
      readFileSync(join(root, "test", fixture), "utf8").replaceAll(
        config.package,
        packageName,
      ),
    );
}
const server = fork(join(root, "test/registry.ts"), [out], {
  stdio: ["ignore", "inherit", "inherit", "ipc"],
});
const [{ port }] = await once(server, "message");
try {
  writeFileSync(
    join(work, "run.sh"),
    `set -eu
export LD_LIBRARY_PATH=/work/runtime/data/data/com.termux/files/usr/lib:$PREFIX/lib
export PATH=/work/runtime/data/data/com.termux/files/usr/bin:$PATH:/system/bin
export HOME=/work/home
export npm_config_cache=/work/cache
mkdir -p "$HOME"
node -p 'JSON.stringify({platform:process.platform,arch:process.arch,node:process.versions.node,napi:process.versions.napi})' > /work/host.json
${cases
  .map(({ name, manager }) => {
    const command =
      manager === "npm"
        ? "node /work/tools/npm/bin/npm-cli.js install --ignore-scripts --include=optional --no-audit --no-fund"
        : "node /work/tools/pnpm/bin/pnpm.cjs install --ignore-scripts --store-dir=/work/pnpm-store";
    return `cd /work/${name}\n${command} --registry=http://127.0.0.1:${port}\nnode smoke.js`;
  })
  .join("\n")}
`,
  );
  run("docker", [
    "run",
    "--rm",
    "--network",
    "host",
    "--security-opt",
    "seccomp=unconfined",
    "-v",
    `${work}:/work`,
    config.androidRuntime.image,
    "sh",
    "/work/run.sh",
  ]);
  const host = readJson(join(work, "host.json"));
  assert.equal(host.platform, "android");
  assert.equal(host.arch, "arm64");
  assert.equal(host.node, config.androidRuntime.nodeVersion);
  const results = [];
  for (const { name, manager, packageName } of cases) {
    run(process.execPath, [
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
      join(work, name, "types.ts"),
      ...(mainManifest.nodePty.features?.aliasTypes
        ? [join(work, name, "types.cts")]
        : []),
    ]);
    results.push({
      kind: "installation",
      manager,
      packageName,
      scripts: false,
      types: true,
      ok: true,
    });
  }
  results.push({ kind: "node", version: host.node, ok: true });
  const proof = {
    platform: "android-arm64",
    version: build.version,
    buildKey: build.buildKey,
    packages: build.packages,
    host,
    runtimes: { node: [host.node], electron: [] },
    results,
    environment: {
      kind: "termux-container",
      libc: "bionic",
      image: config.androidRuntime.image,
      runnerPlatform: process.platform,
      runnerArch: process.arch,
      runtimePackages: config.androidRuntime.packages.map(
        ({ name, version, sha256 }) => ({ name, version, sha256 }),
      ),
    },
    verificationRecipe: verificationRecipe(),
    testedAt: new Date().toISOString(),
  };
  validateDeviceProof(proof, {
    version: build.version,
    buildKey: build.buildKey,
    packages: build.packages,
  });
  writeJson(join(out, "verified.json"), proof);
  console.log(
    `Verified Android/Bionic tarballs in ${config.androidRuntime.image}`,
  );
} finally {
  server.kill();
}
