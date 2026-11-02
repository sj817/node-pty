import { mkdirSync, cpSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import {
  config,
  root,
  run,
  currentPlatform,
  readJson,
  writeJson,
  packageName,
} from "./common.ts";
const tag = process.env.RELEASE_TAG;
if (!/^test-0\.0\.[0-9]+$/.test(tag))
  throw new Error("Invalid test release tag");
const platform = currentPlatform();
const dir = join(root, "dist", platform.id);
mkdirSync(dir, { recursive: true });
run("gh", [
  "release",
  "download",
  tag,
  "--repo",
  config.repository,
  "--pattern",
  "release-manifest.json",
  "--dir",
  dir,
]);
const manifest = readJson(join(dir, "release-manifest.json"));
const version = manifest.version;
if (process.env.GITHUB_ENV)
  appendFileSync(
    process.env.GITHUB_ENV,
    `TEST_VERSION=${version}\nUPSTREAM_TAG=${manifest.upstream.tag}\n`,
  );
const packages = manifest.packages.filter((p) =>
  [config.package, packageName(platform)].includes(p.name),
);
for (const pkg of packages)
  run("gh", [
    "release",
    "download",
    tag,
    "--repo",
    config.repository,
    "--pattern",
    pkg.filename,
    "--dir",
    dir,
  ]);
const mainDir = join(root, "dist/main");
mkdirSync(mainDir, { recursive: true });
const main = packages.find((pkg) => pkg.name === config.package);
cpSync(join(dir, main.filename), join(mainDir, main.filename));
const shared = {
  version,
  buildKey: manifest.buildKey,
  upstream: manifest.upstream,
};
writeJson(join(mainDir, "build.json"), {
  ...shared,
  platform: "main",
  packages: [main],
});
writeJson(join(dir, "build.json"), {
  ...shared,
  platform: platform.id,
  packages,
});
