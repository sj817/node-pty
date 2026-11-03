import assert from "node:assert/strict";
import { mkdirSync, cpSync, readFileSync, existsSync } from "node:fs";
import { validateDeviceProof } from "./proof.ts";
import { verificationRecipe } from "./runtimes.ts";
import { join } from "node:path";
import {
  config,
  root,
  readJson,
  writeJson,
  version,
  buildKey,
  integrity,
  packageName,
  hash,
  releasePlatforms,
  publication,
  recipeKey,
} from "./common.ts";

const key = buildKey();
const dir = join(root, "dist/bundle");
mkdirSync(dir, { recursive: true });
const packages = new Map();
const verification = [];
for (const platform of releasePlatforms) {
  const source = join(root, "dist", platform.id);
  if (platform.os === "android") {
    const build = readJson(join(source, "build.json"));
    assert.equal(build.buildKey, key);
    for (const pkg of build.packages) {
      assert.equal(integrity(join(source, pkg.filename)), pkg.integrity);
      packages.set(pkg.name, { ...pkg, buildKey: key });
      cpSync(join(source, pkg.filename), join(dir, pkg.filename));
    }
    if (existsSync(join(source, "verified.json"))) {
      const proof = readJson(join(source, "verified.json"));
      validateDeviceProof(proof, {
        version,
        buildKey: key,
        packages: [...packages.values()],
      });
      verification.push(proof);
    } else {
      verification.push({
        platform: platform.id,
        pending: "Requires Android device verification of these exact tarballs",
      });
    }
    continue;
  }
  const proof = readJson(join(source, "verified.json"));
  assert.equal(proof.platform, platform.id);
  assert.equal(proof.version, version);
  assert.equal(proof.buildKey, key);
  assert.equal(proof.verificationRecipe, verificationRecipe());
  if (platform.libc === "musl") {
    for (const major of [22, 24, 26])
      assert.ok(
        proof.results.some(
          (r) =>
            r.kind === "node" &&
            Number(r.version.split(".")[0]) === major &&
            r.ok,
        ),
      );
    assert.deepEqual(proof.runtimes.electron, []);
  } else {
    assert.deepEqual(proof.runtimes, config.runtimes);
    for (const node of config.runtimes.node)
      assert.ok(
        proof.results.some(
          (r) => r.kind === "node" && r.version === node && r.ok,
        ),
      );
    for (const electron of config.runtimes.electron)
      for (const asar of [false, true])
        assert.ok(
          proof.results.some(
            (r) =>
              r.kind === "electron" &&
              r.version === electron &&
              r.asar === asar &&
              r.ok,
          ),
        );
  }
  if (platform.libc === "glibc") {
    const baseline = readJson(join(source, "baseline.json"));
    assert.equal(baseline.buildKey, key);
    assert.equal(baseline.host.glibc, platform.glibc);
    assert.ok(
      baseline.results.some((result) => result.kind === "node" && result.ok),
    );
    proof.baseline = baseline;
  }
  for (const manager of ["npm", "pnpm"])
    assert.ok(
      proof.results.some(
        (r) =>
          r.kind === "installation" && r.manager === manager && r.types && r.ok,
      ),
    );
  assert.ok(proof.results.some((r) => r.kind === "omit-optional" && r.ok));
  assert.deepEqual(
    proof.packages.map((p) => p.name).sort(),
    [config.package, packageName(platform)].sort(),
  );
  for (const pkg of proof.packages) {
    assert.equal(integrity(join(source, pkg.filename)), pkg.integrity);
    if (packages.has(pkg.name))
      assert.equal(
        packages.get(pkg.name).integrity,
        pkg.integrity,
        `Nonidentical main package from ${platform.id}`,
      );
    packages.set(pkg.name, { ...pkg, buildKey: key });
    cpSync(join(source, pkg.filename), join(dir, pkg.filename));
  }
  verification.push(proof);
}
const manifest = {
  repository: config.repository,
  version,
  buildKey: key,
  upstream: config.upstream,
  publication,
  recipeKey: recipeKey(),
  verificationRecipe: verificationRecipe(),
  sourceCommit: process.env.GITHUB_SHA || null,
  buildRunId: process.env.GITHUB_RUN_ID || null,
  packages: [...packages.values()].sort((a, b) => a.name.localeCompare(b.name)),
  verification,
};
writeJson(join(dir, "release-manifest.json"), manifest);
console.log(
  `Assembled ${packages.size} packages, manifest SHA256 ${hash(readFileSync(join(dir, "release-manifest.json")))}`,
);
