import test from "node:test";
import assert from "node:assert/strict";
import semver from "semver";
import {
  assertPublication,
  publicationFor,
  releaseVersion,
  shouldPromote,
} from "../scripts/version.ts";
import {
  buildRunName,
  candidatePublication,
  candidateRecipe,
  candidateState,
  selectPublication,
} from "../scripts/sync.ts";
import { changeAreas, diffBase, selectTags } from "../scripts/upstream.ts";
import { hasRuntimeUpdates } from "../scripts/runtimes.ts";
import { validateDeviceProof } from "../scripts/proof.ts";
import { config } from "../scripts/common.ts";

function record(upstream: string, revision = 0, recipe = "recipe") {
  const release = publicationFor(upstream, revision, ["1.1.0"]);
  return {
    version: release.version,
    nodePty: {
      release,
      upstream: { version: upstream, sha: upstream },
      recipeKey: recipe,
    },
  };
}

test("adapting another tag preserves published artifacts until a rebuild is requested", () => {
  const tag = { tag: "v1.1.0", version: "1.1.0", sha: "1.1.0" };
  const existing = record("1.1.0", 1, "verified-recipe");
  const versions = { [existing.version]: existing };
  assert.equal(
    candidateRecipe(tag, versions, "new-adapter"),
    "verified-recipe",
  );
  assert.equal(
    candidateRecipe(tag, versions, "new-adapter", true),
    "new-adapter",
  );
  assert.equal(candidateRecipe(tag, {}, "new-adapter"), "new-adapter");
  assert.throws(() =>
    candidateRecipe({ ...tag, sha: "moved" }, versions, "new"),
  );
});

test("multiple completed candidates wait behind the active publication without replacing pending runs", () => {
  const candidates = [
    { state: "built", runId: 1 },
    { state: "built", runId: 2 },
  ];
  assert.equal(selectPublication(candidates, []), candidates[0]);
  for (const status of ["queued", "pending", "in_progress"])
    assert.equal(selectPublication(candidates, [{ status }]), null);
  assert.equal(
    selectPublication(candidates, [{ status: "completed" }]),
    candidates[0],
  );
});

test("upstream versions and downstream revisions occupy disjoint stable slots", () => {
  assert.equal(publicationFor("1.1.0", 0, ["1.1.0"]).version, "1.1.1");
  assert.equal(releaseVersion("1.1.1", 0), "1.1.1000");
  assert.ok(
    semver.lt(releaseVersion("1.1.0", 999), releaseVersion("1.1.1", 0)),
  );
  assert.equal(releaseVersion("1.2.0-beta.17", 2), "1.2.0-beta.17.qwqo.2");
  assert.ok(
    semver.lt(
      releaseVersion("1.2.0-beta.17", 999),
      releaseVersion("1.2.0-beta.18", 0),
    ),
  );
  assert.ok(
    semver.lt(releaseVersion("1.2.0-beta.17", 999), releaseVersion("1.2.0", 0)),
  );
  for (const revision of [-1, 1000, 0.5])
    assert.throws(() => releaseVersion("1.1.0", revision));
});

test("stable and prerelease channels remain separate, including legacy beta spellings", () => {
  assert.equal(publicationFor("1.1.0").channel, "latest");
  assert.equal(publicationFor("1.1.0-beta43").channel, "next");
  assert.equal(publicationFor("1.2.0-beta.17").channel, "next");
  assertPublication("1.1.1", "latest");
  assertPublication("1.2.0-beta.17.qwqo.0", "next");
  assert.throws(() => assertPublication("1.1.1", "next"));
  assert.throws(() => assertPublication("1.2.0-beta.17.qwqo.0", "latest"));
});

test("out-of-order backfills retain the newest verified release in each channel", () => {
  assert.equal(
    shouldPromote(record("1.2.0-beta.17"), record("1.2.0-beta.2"), "next"),
    false,
  );
  assert.equal(
    shouldPromote(record("1.2.0-beta.2"), record("1.2.0-beta.17"), "next"),
    true,
  );
  assert.equal(
    shouldPromote(record("1.1.0", 1), record("1.1.0", 2), "latest"),
    true,
  );
  assert.equal(
    shouldPromote(record("1.1.0", 2), record("1.1.0", 1), "latest"),
    false,
  );
  assert.throws(() =>
    shouldPromote(record("1.1.0"), record("1.2.0-beta.17"), "latest"),
  );
  const moved = record("1.1.0", 2);
  moved.nodePty.upstream.sha = "moved";
  assert.throws(
    () => shouldPromote(record("1.1.0", 1), moved, "latest"),
    /conflicting/,
  );
  assert.equal(
    shouldPromote({ version: "0.0.1" }, record("1.1.0", 1), "latest"),
    true,
  );
});

test("selection skips superseded old betas and finds independent diff bases", () => {
  const tags = [
    "1.0.0",
    "1.1.0-beta43",
    "1.1.0",
    "1.1.1",
    "1.2.0-beta.2",
    "1.2.0-beta.3",
    "1.2.0",
    "1.3.0-beta.1",
  ].map((version) => ({ tag: `v${version}`, version, sha: version }));
  assert.equal(selectTags(tags, "1.1.0").length, 6);
  assert.equal(diffBase(tags[3], tags).version, "1.1.0");
  assert.equal(diffBase(tags[5], tags).version, "1.2.0-beta.2");
  assert.equal(diffBase(tags[7], tags).version, "1.2.0");
  assert.deepEqual(
    changeAreas([
      "src/win/conpty.cc",
      "src/unix/pty.cc",
      "src/unixTerminal.ts",
      "typings/node-pty.d.ts",
      "package-lock.json",
      "publish.yml",
      "LICENSE",
    ]),
    ["build", "ci", "licenses", "native", "runtime", "types"],
  );
});

test("the same recipe reuses its revision and a changed recipe allocates the next", () => {
  const tag = { tag: "v1.1.0", version: "1.1.0", sha: "1.1.0" };
  assert.equal(candidatePublication(tag, {}, "recipe").revision, 1);
  const previous = record("1.1.0", 1);
  assert.equal(
    candidatePublication(tag, { [previous.version]: previous }, "recipe")
      .revision,
    1,
  );
  assert.equal(
    candidatePublication(tag, { [previous.version]: previous }, "changed")
      .revision,
    2,
  );
  assert.throws(() =>
    candidatePublication(
      { ...tag, sha: "moved" },
      { [previous.version]: previous },
      "recipe",
    ),
  );
});

test("a queue waits for active builds, resumes successful artifacts, and reports failed publications", () => {
  const candidate = {
    recipeKey: "key",
    sha: "1.1.0",
    publication: publicationFor("1.1.0", 1),
  };
  const name = buildRunName("key", 1);
  const run = {
    id: 10,
    display_title: name,
    status: "in_progress",
    html_url: "build-url",
  };
  assert.equal(candidateState(candidate, {}, [], [], []).state, "queued");
  assert.equal(candidateState(candidate, {}, [run], [], []).state, "building");
  const built = { ...run, status: "completed", conclusion: "success" };
  assert.equal(candidateState(candidate, {}, [built], [], []).state, "built");
  const failed = {
    id: 20,
    display_title: "publish-10",
    status: "completed",
    conclusion: "failure",
  };
  assert.equal(
    candidateState(candidate, {}, [built], [failed], []).state,
    "publish-failed",
  );
  assert.equal(
    candidateState(
      candidate,
      {},
      [built],
      [{ ...failed, conclusion: "success" }],
      [],
    ).state,
    "registry-pending",
  );
  const stored = record("1.1.0", 1, "key");
  assert.equal(
    candidateState(
      candidate,
      { [stored.version]: stored },
      [built],
      [],
      [{ tag_name: "v1.1.1", draft: false }],
    ).state,
    "published",
  );
  assert.equal(
    candidateState(
      candidate,
      { [stored.version]: record("1.1.0", 1, "wrong") },
      [],
      [],
      [],
    ).state,
    "conflict",
  );
});

test("an extra configured minimum Node version does not falsely trigger a runtime update", () => {
  assert.equal(
    hasRuntimeUpdates(
      { node: ["22.14.0", "22.23.4"], electron: ["45.2.1"] },
      { node: ["22.23.4"], electron: ["45.2.1"] },
    ),
    false,
  );
  assert.equal(
    hasRuntimeUpdates(
      { node: ["22.14.0", "22.23.4"], electron: ["45.2.1"] },
      { node: ["24.22.2"], electron: ["45.2.1"] },
    ),
    true,
  );
});

test("Android container proof identifies Bionic and the exact pinned runtime without claiming a device API", () => {
  const packages = [config.package, `${config.package}-android-arm64`].map(
    (name) => ({ name, integrity: name }),
  );
  const proof = {
    platform: "android-arm64",
    version: "1.1.1",
    buildKey: "key",
    packages,
    host: {
      platform: "android",
      arch: "arm64",
      node: config.androidRuntime.nodeVersion,
    },
    environment: {
      kind: "termux-container",
      libc: "bionic",
      image: config.androidRuntime.image,
      runnerPlatform: "linux",
      runnerArch: "arm64",
      runtimePackages: config.androidRuntime.packages.map(
        ({ name, version, sha256 }) => ({ name, version, sha256 }),
      ),
    },
    runtimes: { node: [config.androidRuntime.nodeVersion], electron: [] },
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
  const manifest = { version: "1.1.1", buildKey: "key", packages };
  validateDeviceProof(proof, manifest);
  assert.throws(() =>
    validateDeviceProof(
      { ...proof, environment: { ...proof.environment, libc: "glibc" } },
      manifest,
    ),
  );
  assert.throws(() =>
    validateDeviceProof(
      {
        ...proof,
        environment: { ...proof.environment, image: "floating:latest" },
      },
      manifest,
    ),
  );
});
