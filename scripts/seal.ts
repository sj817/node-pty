import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  config,
  root,
  version,
  github,
  githubPages,
  run,
  files,
  hash,
  readJson,
  writeJson,
  publication,
  recipeKey,
  jsonRequest,
} from "./common.ts";
import { completeVerification } from "./proof.ts";
import { releaseTag } from "./version.ts";
const tag = releaseTag(publication, config.upstream.version);
const sha = run("git", ["rev-parse", "HEAD"], { capture: true });
// GitHub omits draft releases from GET /releases/tags/:tag, but includes
// them in the authenticated release list. Draft tags also lack a Git ref.
async function findRelease() {
  const releases = await githubPages(`repos/${config.repository}/releases`);
  return releases.find((item) => item.tag_name === tag) || null;
}
async function waitForRelease() {
  for (let attempt = 0; attempt < 60; attempt++) {
    const found = await findRelease();
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error(`Draft release ${tag} is not visible after creation`);
}
let release = await findRelease();
const ref = await github(`repos/${config.repository}/git/ref/tags/${tag}`, {
  allow404: true,
});
if (ref && (ref.object.type !== "commit" || ref.object.sha !== sha))
  throw new Error(`Release tag conflict ${tag}`);
if (release && release.target_commitish !== sha)
  throw new Error(`Release target conflict ${tag}`);
if (process.argv.includes("--finalize")) {
  if (!release) throw new Error("Missing sealed release");
  const tags = await jsonRequest(
    `https://registry.npmjs.org/-/package/${encodeURIComponent(config.package)}/dist-tags`,
  );
  run("gh", [
    "release",
    "edit",
    tag,
    "--repo",
    config.repository,
    "--draft=false",
    `--prerelease=${publication.mode === "test" || publication.channel === "next"}`,
    `--latest=${publication.channel === "latest" && tags.latest === version}`,
    "--title",
    tag,
  ]);
  process.exit(0);
}
const dir = join(root, "dist/bundle");
const manifest = readJson(join(dir, "release-manifest.json"));
completeVerification(manifest, process.env.ANDROID_PROOF);
writeJson(join(dir, "release-manifest.json"), manifest);
if (manifest.sourceCommit !== sha)
  throw new Error("Artifact source commit differs from release commit");
if (!release) {
  run("gh", [
    "release",
    "create",
    tag,
    "--repo",
    config.repository,
    "--target",
    sha,
    "--draft",
    `--prerelease=${publication.mode === "test" || publication.channel === "next"}`,
    "--title",
    tag,
    "--notes",
    `npm ${publication.channel} build ${version}. Upstream ${config.upstream.tag} at ${config.upstream.sha}. Downstream revision ${publication.revision}. Runtime verification and checksums are in release-manifest.json.\n\n<!-- node-pty-release ${JSON.stringify({ version, upstream: config.upstream, publication, recipeKey: recipeKey(), sourceCommit: sha, buildRunId: manifest.buildRunId })} -->`,
  ]);
  release = await waitForRelease();
  if (release.target_commitish !== sha)
    throw new Error(`Release target conflict ${tag}`);
}
const checkDir = join(root, ".work/sealed");
mkdirSync(checkDir, { recursive: true });
for (const file of files(dir)) {
  const asset = release.assets.find((a) => a.name === file);
  if (asset) {
    run("gh", [
      "release",
      "download",
      tag,
      "--repo",
      config.repository,
      "--pattern",
      file,
      "--dir",
      checkDir,
      "--clobber",
    ]);
    if (
      hash(readFileSync(join(dir, file))) !==
      hash(readFileSync(join(checkDir, file)))
    )
      throw new Error(`Sealed artifact conflict ${file}`);
  } else {
    run("gh", [
      "release",
      "upload",
      tag,
      join(dir, file),
      "--repo",
      config.repository,
    ]);
  }
}
