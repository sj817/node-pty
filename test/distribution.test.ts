import test from "node:test";
import assert from "node:assert/strict";
import { adaptUpstream, compileEsm } from "../scripts/adapt.ts";
import { classifyNativeSource } from "../scripts/history.ts";
import { validateDeviceProof } from "../scripts/proof.ts";
import { buildKey, config, root } from "../scripts/common.ts";
import { execFileSync } from "node:child_process";

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
