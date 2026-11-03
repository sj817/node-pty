import test from "node:test";
import assert from "node:assert/strict";
import {
  adaptUpstream,
  compileEsm,
  externalDeclarations,
} from "../scripts/adapt.ts";
import { classifyNativeSource } from "../scripts/history.ts";
import { validateDeviceProof } from "../scripts/proof.ts";
import { buildKey, config, root } from "../scripts/common.ts";
import { execFileSync } from "node:child_process";
import { requiredChecksFor } from "../scripts/gate.ts";
import { compatibilityKey } from "../scripts/detect.ts";

test("tag-specific gates use the test job declared by that exact source", () => {
  const checks = requiredChecksFor({
    tag: "v1.2.0-beta.17",
    sha: "02733b571b980b6418ff3bf2247f901463a58344",
  });
  assert.ok(
    checks.includes("node-pty (publish) (node-pty Linux (Node.js 24.22.1))"),
  );
  assert.ok(
    !checks.includes("node-pty (publish) (node-pty Linux (Node.js 20.x))"),
  );
  assert.deepEqual(
    requiredChecksFor({
      tag: "v1.1.0",
      sha: "1def5774632305246fe21f0f69e23a664d6c5910",
    }),
    config.requiredChecks,
  );
});

test("runtime deduplication distinguishes downstream test releases", () => {
  const runtimes = { node: ["24.22.2"], electron: ["45.2.1"] };
  assert.notEqual(
    compatibilityKey(config.upstream, "0.0.2", runtimes),
    compatibilityKey(config.upstream, "0.0.3", runtimes),
  );
});

test("default and explicit upstream selection produce identical build metadata", () => {
  const output = execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      "import {buildKey,config} from './scripts/common.ts'; console.log(JSON.stringify({key:buildKey(),source:config.upstream}))",
    ],
    {
      cwd: root,
      env: { ...process.env, UPSTREAM_TAG: config.upstream.tag },
      encoding: "utf8",
    },
  );
  assert.equal(
    output.trim(),
    JSON.stringify({ key: buildKey(), source: config.upstream }),
  );
});

test("upstream module adaptation keeps ESM imports and real helper paths", () => {
  const output = adaptUpstream(
    "import { A } from './shared/a'; export const item = require('./windowsTerminal').WindowsTerminal; export const dir = __dirname;",
    "index.ts",
  );
  assert.match(output, /distributionCreateRequire/);
  assert.match(output, /windowsTerminal\.js/);
  assert.match(output, /import\.meta\.url/);
  assert.doesNotMatch(output, /module\.exports|exports\./);
  assert.match(
    compileEsm("export { unpacked } from './loader.ts';", "entry.ts"),
    /loader\.js/,
  );
});

test("declaration adaptation preserves nested types and rejects unreviewed module layouts", () => {
  const body =
    "export namespace nested { export interface Value { text: string; } }";
  const result = externalDeclarations(
    `/** upstream license */\ndeclare module 'node-pty' {\n${body}\n}`,
  );
  assert.ok(result.includes("/** upstream license */"));
  assert.ok(result.includes(body));
  for (const source of [
    "export interface Value {}",
    "declare module 'other-package' {}",
    "declare module 'node-pty' {}\nexport interface Extra {}",
  ])
    assert.throws(() => externalDeclarations(source), /Unreviewed/);
});

test("history classifies direct V8 separately from Node-API", () => {
  assert.equal(
    classifyNativeSource("#include <napi.h>\nNODE_API_MODULE(pty, init)"),
    "node-api",
  );
  assert.equal(
    classifyNativeSource("using namespace v8;\nNODE_MODULE(pty, init)"),
    "node-v8",
  );
  assert.equal(classifyNativeSource("NAN_MODULE_INIT(init)"), "node-v8");
  assert.equal(classifyNativeSource(""), "unknown");
});

test("Android publication proof requires Bionic identity and exact tarballs", () => {
  const packages = [config.package, `${config.package}-android-arm64`].map(
    (name) => ({ name, integrity: name }),
  );
  const manifest = { version: "0.0.2", buildKey: "key", packages };
  const proof = {
    platform: "android-arm64",
    version: "0.0.2",
    buildKey: "key",
    packages,
    host: { platform: "android", arch: "arm64", androidApi: 36 },
    runtimes: { node: ["24.22.2"], electron: [] },
    results: [
      { kind: "node", ok: true },
      ...["npm", "pnpm"].map((manager) => ({
        kind: "installation",
        manager,
        scripts: false,
        ok: true,
      })),
    ],
  };
  validateDeviceProof(proof, manifest);
  assert.throws(() =>
    validateDeviceProof(
      { ...proof, host: { ...proof.host, platform: "linux" } },
      manifest,
    ),
  );
  assert.throws(() =>
    validateDeviceProof({ ...proof, buildKey: "other" }, manifest),
  );
  assert.throws(() =>
    validateDeviceProof(
      { ...proof, packages: [{ name: config.package, integrity: "wrong" }] },
      manifest,
    ),
  );
});
