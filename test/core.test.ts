import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { hash, assertTestPublication } from "../scripts/common.ts";
import { evaluateChecks } from "../scripts/gate.ts";
import { publishPackages, publishPlan } from "../scripts/publish.ts";
import { shouldTest, latestPerMajor } from "../scripts/detect.ts";
import { nativePaths, platformId, unpacked } from "../runtime/loader.ts";

test("runtime checks deduplicate successful and in-flight fingerprints, retry failures", () => {
  assert.equal(
    shouldTest("abc", [{ display_title: "abc", status: "queued" }]),
    false,
  );
  assert.equal(
    shouldTest("abc", [
      { display_title: "abc", status: "completed", conclusion: "success" },
    ]),
    false,
  );
  assert.equal(
    shouldTest("abc", [
      { display_title: "abc", status: "completed", conclusion: "failure" },
    ]),
    true,
  );
  assert.equal(
    shouldTest("new", [
      { display_title: "abc", status: "completed", conclusion: "success" },
    ]),
    true,
  );
  assert.deepEqual(
    latestPerMajor(["22.1.0", "22.2.0", "24.1.0", "24.2.0-rc.1"], [22, 24]),
    ["22.2.0", "24.1.0"],
  );
});

test("gate requires exact SHA, provider, name and successful completion", () => {
  const check = {
    id: 1,
    name: "build",
    head_sha: "abc",
    app: { slug: "azure-pipelines" },
    status: "completed",
    conclusion: "success",
  };
  const evaluate = (checks) =>
    evaluateChecks("abc", checks, [], ["build"]).ready;
  assert.ok(evaluate([check]));
  assert.equal(evaluate([]), false);
  for (const changed of [
    { head_sha: "other" },
    { conclusion: "failure" },
    { status: "in_progress" },
    { app: { slug: "other" } },
    { conclusion: "neutral" },
    { conclusion: "skipped" },
  ])
    assert.equal(evaluate([{ ...check, ...changed }]), false);
  assert.equal(
    evaluate([check, { ...check, id: 2, conclusion: "failure" }]),
    false,
  );
  assert.equal(
    evaluateChecks(
      "abc",
      [check],
      [{ context: "ci", state: "pending" }],
      ["build"],
    ).ready,
    false,
  );
});
test("platform selection follows npm vocabulary and identifies libc", () => {
  assert.equal(platformId("win32", "arm64"), "win32-arm64");
  assert.equal(platformId("darwin", "x64"), "darwin-x64");
  assert.equal(
    platformId("linux", "x64", { header: { glibcVersionRuntime: "2.35" } }),
    "linux-x64-glibc",
  );
  assert.equal(
    platformId("linux", "arm64", {
      header: {},
      sharedObjects: ["/lib/ld-musl-aarch64.so.1"],
    }),
    "linux-arm64-musl",
  );
  assert.throws(() => platformId("linux", "x64", {}), { code: "ERR_PTY_LIBC" });
  assert.throws(() => platformId("win32", "amd64"), {
    code: "ERR_PTY_PLATFORM",
  });
  assert.equal(
    unpacked("/app/resources/app.asar/node_modules/pkg/bin"),
    "/app/resources/app.asar.unpacked/node_modules/pkg/bin",
  );
  assert.equal(
    unpacked("/app/resources/app.asar.unpacked/node_modules/pkg/bin"),
    "/app/resources/app.asar.unpacked/node_modules/pkg/bin",
  );
});
test("ASAR native loading leaves the helper path for upstream to unpack once", () => {
  const metadata = join(
    process.cwd(),
    "app.asar",
    "node_modules",
    "@qwqo",
    "node-pty-darwin-arm64",
    "package.json",
  );
  const { dir, file } = nativePaths(metadata, "pty");
  assert.ok(dir.includes("app.asar"));
  assert.ok(!dir.includes("app.asar.unpacked"));
  assert.equal(file, join(unpacked(dir), "pty.node"));
  assert.ok(unpacked(join(dir, "spawn-helper")).includes("app.asar.unpacked"));
  assert.ok(!unpacked(join(dir, "spawn-helper")).includes("unpacked.unpacked"));
  const resolvedOutsideAsar = nativePaths(unpacked(metadata), "pty");
  assert.equal(resolvedOutsideAsar.dir, dir);
  assert.equal(resolvedOutsideAsar.file, file);
});
test("partial publish retries immutable packages and never exposes main before children", async () => {
  const packages = ["main", "linux", "windows"].map((name) => ({
    name,
    version: "0.0.2",
    buildKey: "key",
    integrity: hash(name),
  }));
  const existing: Record<
    string,
    { dist: { integrity: string }; nodePty: { buildKey: string } }
  > = {};
  const calls = [];
  let shouldFail = true;
  const adapter = {
    get: async (pkg) => existing[pkg.name] || null,
    publish: async (pkg) => {
      calls.push(pkg.name);
      if (pkg.name === "windows" && shouldFail)
        throw new Error("temporary registry failure");
      existing[pkg.name] = {
        dist: { integrity: pkg.integrity },
        nodePty: { buildKey: pkg.buildKey },
      };
    },
    confirm: async (pkg) => assert.ok(existing[pkg.name]),
    tag: async (pkg) => calls.push(`tag:${pkg.name}`),
  };
  await publishPackages(packages, adapter, "main", "next", true);
  assert.deepEqual(calls, []);
  await assert.rejects(publishPackages(packages, adapter, "main", "next"));
  assert.equal(existing.main, undefined);
  shouldFail = false;
  await publishPackages(packages, adapter, "main", "next");
  assert.deepEqual(calls, [
    "linux",
    "windows",
    "windows",
    "main",
    "tag:linux",
    "tag:windows",
    "tag:main",
  ]);
  const count = calls.filter((name) => name === "main").length;
  await publishPackages(packages, adapter, "main", "next");
  assert.equal(calls.filter((name) => name === "main").length, count);
  assert.throws(
    () =>
      publishPlan(packages, { main: { dist: { integrity: "wrong" } } }, "main"),
    /conflict/,
  );
});

test("a child awaiting registry availability blocks the primary package", async () => {
  const packages = ["main", "linux"].map((name) => ({
    name,
    version: "0.0.2",
    buildKey: "key",
    integrity: hash(name),
  }));
  const published = new Map<string, object>();
  let ready = false;
  const adapter = {
    get: async (pkg) => published.get(pkg.name) || null,
    publish: async (pkg) => {
      published.set(pkg.name, {
        dist: { integrity: pkg.integrity },
        nodePty: { buildKey: pkg.buildKey },
      });
    },
    confirm: async (pkg) => {
      if (pkg.name === "linux" && !ready)
        throw new Error("tarball still processing");
    },
    tag: async () => {},
  };
  await assert.rejects(
    publishPackages(packages, adapter, "main", "next"),
    /still processing/,
  );
  assert.equal(published.has("main"), false);
  ready = true;
  await publishPackages(packages, adapter, "main", "next");
  assert.equal(published.has("main"), true);
});

test("publication accepts only the temporary next test range", () => {
  assertTestPublication("0.0.2", "next");
  assertTestPublication("0.0.100", "next");
  for (const version of ["1.1.0", "0.0.101", "0.0.0", "0.1.0"])
    assert.throws(() => assertTestPublication(version, "next"));
  assert.throws(() => assertTestPublication("0.0.2", "latest"));
});
