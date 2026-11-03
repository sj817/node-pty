import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import semver from "semver";
import { config, github, readJson, root, run } from "./common.ts";
import { publicationFor } from "./version.ts";

const id = process.env.BUILD_RUN_ID;
if (!/^\d+$/.test(id)) throw new Error("A build run ID is required");
const build = await github(`repos/${config.repository}/actions/runs/${id}`);
if (
  build.conclusion !== "success" ||
  build.head_branch !== "main" ||
  build.head_repository.full_name !== config.repository ||
  build.path !== ".github/workflows/build.yml" ||
  !["push", "workflow_dispatch"].includes(build.event)
)
  throw new Error(
    "Publication requires a successful main-branch build from this repository",
  );
if (process.env.GITHUB_SHA && process.env.GITHUB_SHA !== build.head_sha)
  throw new Error(
    `Dispatch publication from ci/${build.head_sha} so npm provenance identifies the original build commit`,
  );
const dir = join(root, ".work/publication-source", id);
mkdirSync(dir, { recursive: true });
run("gh", [
  "run",
  "download",
  id,
  "--repo",
  config.repository,
  "--name",
  "release-bundle",
  "--dir",
  dir,
]);
const manifest = readJson(join(dir, "release-manifest.json"));
if (
  manifest.sourceCommit !== build.head_sha ||
  manifest.repository !== config.repository ||
  !/^[a-f0-9]{40}$/.test(build.head_sha) ||
  !semver.valid(manifest.upstream.tag) ||
  !semver.valid(manifest.version)
)
  throw new Error("Build manifest source identity mismatch");
const publication =
  manifest.publication ||
  publicationFor(manifest.upstream.version, 0, [], manifest.version);
const expected = publicationFor(
  manifest.upstream.version,
  publication.revision,
  config.versioning.reserved,
  publication.mode === "test" ? manifest.version : undefined,
);
if (JSON.stringify(publication) !== JSON.stringify(expected))
  throw new Error("Unexpected downstream version mapping");
const android = manifest.verification.find(
  (proof) => proof.platform === "android-arm64",
);
const ready = Boolean(
  process.env.ANDROID_PROOF || (android && !android.pending),
);
for (const [key, value] of Object.entries({
  sha: build.head_sha,
  upstream_tag: manifest.upstream.tag,
  revision: publication.revision,
  test_version: publication.mode === "test" ? publication.version : "",
  version: publication.version,
  ready,
}))
  appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
if (!ready) {
  const message = `Publication of ${manifest.version} is pending Android device proof for build ${id}.\n`;
  console.log(message);
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, message);
}
