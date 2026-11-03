import semver from "semver";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  config,
  root,
  github,
  githubPages,
  jsonRequest,
  writeJson,
  readJson,
} from "./common.ts";
import { gate } from "./gate.ts";
import { refreshTags, selectTags, sourceDiff } from "./upstream.ts";
import {
  compatibilityKey,
  discoverRuntimes,
  hasRuntimeUpdates,
  muslImages,
  verificationRecipe,
} from "./runtimes.ts";
export {
  compatibilityKey,
  latestPerMajor,
  hasRuntimeUpdates,
} from "./runtimes.ts";

export function shouldTest(
  key: string,
  runs: Array<{ display_title: string; status: string; conclusion?: string }>,
): boolean {
  return !runs.some(
    (run) =>
      run.display_title === key &&
      (run.status !== "completed" || run.conclusion === "success"),
  );
}

async function main() {
  const records = await refreshTags(readJson(join(root, "upstream-tags.json")));
  writeJson(join(root, "upstream-tags.json"), records);
  const candidates = [];
  for (const tag of selectTags(records, config.sync.minimumUpstream)) {
    let state;
    try {
      state = await gate({ tag: tag.tag, sha: tag.sha });
    } catch (error) {
      state = { ready: false, reasons: [String(error)] };
    }
    candidates.push({
      ...tag,
      ...state,
      prerelease: Boolean(semver.prerelease(tag.version)),
      diff: sourceDiff(tag, records),
    });
  }
  const runtimes = await discoverRuntimes();
  const report = {
    tags: records.length,
    minimumUpstream: config.sync.minimumUpstream,
    candidates,
    configuredRuntimes: config.runtimes,
    discoveredRuntimes: runtimes,
    runtimeTests: [],
  };
  writeJson(join(root, "dist/detection.json"), report);
  console.log(
    JSON.stringify(
      {
        tags: records.length,
        selected: candidates.length,
        readyForBuild: candidates.filter(
          (item) => item.ready && item.api === "node-api",
        ).length,
      },
      null,
      2,
    ),
  );
  if (process.env.DISPATCH_COMPATIBILITY === "1") {
    const registry = await jsonRequest(
      `https://registry.npmjs.org/${encodeURIComponent(config.package)}`,
    );
    const releases = await githubPages(`repos/${config.repository}/releases`);
    const runs = await githubPages(
      `repos/${config.repository}/actions/workflows/compatibility.yml/runs?event=workflow_dispatch`,
      "workflow_runs",
    );
    let images;
    for (const channel of ["latest", "next"]) {
      const version = registry["dist-tags"][channel];
      const record = registry.versions[version];
      if (record?.nodePty?.release?.mode !== "release") continue;
      const release = releases.find(
        (item) => item.tag_name === `v${version}` && !item.draft,
      );
      const asset = release?.assets.find(
        (item) => item.name === "release-manifest.json",
      );
      if (!asset)
        throw new Error(
          `Published ${channel} version ${version} lacks its release manifest`,
        );
      const manifest = await jsonRequest(asset.browser_download_url);
      const proofs = manifest.verification;
      const needsTest = proofs.some(
        (proof) =>
          proof.verificationRecipe !== verificationRecipe() ||
          hasRuntimeUpdates(
            proof.runtimes,
            proof.platform.startsWith("android-")
              ? { node: [config.androidRuntime.nodeVersion], electron: [] }
              : {
                  node: runtimes.node,
                  electron: proof.platform.endsWith("musl")
                    ? []
                    : runtimes.electron,
                },
          ),
      );
      if (!needsTest) continue;
      images ||= await muslImages(runtimes.node);
      const matrix = { ...runtimes, muslImages: images };
      const key = compatibilityKey(manifest.upstream, version, matrix);
      const needed = shouldTest(key, runs);
      report.runtimeTests.push({ channel, version, key, dispatched: needed });
      if (needed)
        await github(
          `repos/${config.repository}/actions/workflows/compatibility.yml/dispatches`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              ref: "main",
              inputs: {
                key,
                runtimes: JSON.stringify(matrix),
                release: release.tag_name,
              },
            }),
          },
        );
    }
    writeJson(join(root, "dist/detection.json"), report);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await main();
