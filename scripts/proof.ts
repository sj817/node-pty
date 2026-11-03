import assert from "node:assert/strict";
import { config, releasePlatforms } from "./common.ts";

export function validateDeviceProof(proof, manifest) {
  assert.equal(proof.platform, "android-arm64");
  assert.equal(proof.version, manifest.version);
  assert.equal(proof.buildKey, manifest.buildKey);
  if (manifest.verificationRecipe)
    assert.equal(proof.verificationRecipe, manifest.verificationRecipe);
  assert.equal(proof.host.platform, "android");
  assert.equal(proof.host.arch, "arm64");
  if (proof.environment?.kind === "termux-container") {
    assert.equal(proof.environment.libc, "bionic");
    assert.equal(proof.environment.image, config.androidRuntime.image);
    assert.equal(proof.environment.runnerPlatform, "linux");
    assert.equal(proof.environment.runnerArch, "arm64");
    assert.equal(proof.host.node, config.androidRuntime.nodeVersion);
    assert.deepEqual(
      proof.environment.runtimePackages,
      config.androidRuntime.packages.map(({ name, version, sha256 }) => ({
        name,
        version,
        sha256,
      })),
    );
  } else {
    assert.ok(
      !proof.environment?.kind || proof.environment.kind === "device",
      "Unknown Android verification environment",
    );
    assert.ok(proof.host.androidApi >= 24);
  }
  for (const name of [config.package, `${config.package}-android-arm64`]) {
    const expected = manifest.packages.find((pkg) => pkg.name === name);
    assert.ok(expected);
    assert.equal(
      proof.packages.find((pkg) => pkg.name === name)?.integrity,
      expected.integrity,
    );
  }
  for (const manager of ["npm", "pnpm"]) {
    assert.ok(
      proof.results.some(
        (result) =>
          result.kind === "installation" &&
          result.manager === manager &&
          result.scripts === false &&
          result.ok,
      ),
    );
  }
  assert.ok(
    proof.results.some((result) => result.kind === "node" && result.ok),
  );
  assert.deepEqual(proof.runtimes.electron, []);
}

export function completeVerification(manifest, deviceProof?: string) {
  if (deviceProof) {
    const proof = JSON.parse(deviceProof);
    validateDeviceProof(proof, manifest);
    manifest.verification = manifest.verification.filter(
      (item) => item.platform !== proof.platform,
    );
    manifest.verification.push(proof);
  }
  for (const platform of releasePlatforms) {
    const proof = manifest.verification.find(
      (item) => item.platform === platform.id,
    );
    assert.ok(
      proof && !proof.pending,
      `Target runtime verification is missing for ${platform.id}`,
    );
    if (platform.os === "android") validateDeviceProof(proof, manifest);
  }
  return manifest;
}
