import semver from "semver";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  config,
  root,
  github,
  githubPages,
  jsonRequest,
  hash,
  writeJson,
  readJson,
} from "./common.ts";
import { gate, resolveTag } from "./gate.ts";

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
export function latestPerMajor(versions: string[], majors: number[]): string[] {
  return majors
    .map(
      (major) =>
        versions
          .filter(
            (v) =>
              semver.valid(v) &&
              !semver.prerelease(v) &&
              semver.major(v) === major,
          )
          .sort(semver.rcompare)[0],
    )
    .filter(Boolean);
}

export function compatibilityKey(upstream, version: string, runtimes): string {
  return `compatibility-${hash(JSON.stringify({ upstream, version, runtimes })).slice(0, 24)}`;
}
async function main() {
  // Always check the pinned tag, including on runs without newer releases.
  const pinned = await gate();
  const tags = await githubPages(`repos/${config.upstream.repository}/tags`);
  const ordered = tags
    .map((t) => ({ ...t, version: semver.valid(t.name) }))
    .filter((t) => t.version)
    .sort((a, b) => semver.rcompare(a.version, b.version));
  const locked = readJson(join(root, "upstream-tags.json"));
  const candidates = [];
  for (const tag of ordered) {
    const previous = locked.find((item) => item.tag === tag.name);
    const sha = await resolveTag(tag.name);
    if (previous && previous.sha !== sha)
      throw new Error("MOVED TAG " + tag.name);
    let state;
    try {
      state = await gate({ tag: tag.name, sha });
    } catch (error) {
      state = { tag: tag.name, sha, ready: false, reasons: [String(error)] };
    }
    const action = !previous
      ? "pin and inspect source"
      : previous.api !== "node-api"
        ? "pending historical Node/V8 ABI adapter"
        : state.ready
          ? "available for per-tag build and runtime tests"
          : "pending exact-SHA upstream CI";
    candidates.push({
      ...state,
      api: previous?.api || "unknown",
      prerelease: Boolean(semver.prerelease(tag.version)),
      action,
    });
  }
  const [schedule, nodeIndex, electronIndex] = await Promise.all([
    jsonRequest(
      "https://raw.githubusercontent.com/nodejs/Release/main/schedule.json",
    ),
    jsonRequest("https://nodejs.org/dist/index.json"),
    jsonRequest("https://releases.electronjs.org/releases.json"),
  ]);
  const today = new Date().toISOString().slice(0, 10);
  const majors = Object.entries(
    schedule as Record<string, { start: string; end: string }>,
  )
    .filter(([, s]) => s.start <= today && s.end >= today)
    .map(([name]) => Number(name.slice(1)));
  const electronVersions = electronIndex
    .map((r) => r.version)
    .filter((v) => semver.valid(v) && !semver.prerelease(v));
  const electronMajors = [
    ...new Set<number>(electronVersions.map((v) => semver.major(v))),
  ]
    .sort((a, b) => b - a)
    .slice(0, 3)
    .sort((a, b) => a - b);
  const runtimes = {
    node: latestPerMajor(
      nodeIndex.map((r) => r.version.replace(/^v/, "")),
      majors,
    ),
    electron: latestPerMajor(electronVersions, electronMajors),
  };
  const key = compatibilityKey(
    config.upstream,
    config.publication.version,
    runtimes,
  );
  const report = {
    pinned,
    candidates,
    configuredRuntimes: config.runtimes,
    discoveredRuntimes: runtimes,
    key,
  };
  writeJson(join(root, "dist/detection.json"), report);
  console.log(
    JSON.stringify(
      {
        tags: candidates.length,
        readyForBuild: candidates.filter(
          (item) => item.ready && item.api === "node-api",
        ).length,
        key,
      },
      null,
      2,
    ),
  );
  if (!pinned.ready)
    throw new Error(
      `Pinned source CI is pending: ${pinned.reasons.join("; ")}`,
    );
  if (
    process.env.DISPATCH_COMPATIBILITY === "1" &&
    JSON.stringify(runtimes) !== JSON.stringify(config.runtimes)
  ) {
    const releases = await githubPages(`repos/${config.repository}/releases`);
    const release = releases.find(
      (item) =>
        !item.draft && item.tag_name === `test-${config.publication.version}`,
    );
    if (!release) {
      console.log("Runtime update pending the first verified release.");
      return;
    }
    const runs = await githubPages(
      `repos/${config.repository}/actions/workflows/compatibility.yml/runs?event=workflow_dispatch`,
      "workflow_runs",
    );
    if (shouldTest(key, runs))
      await github(
        `repos/${config.repository}/actions/workflows/compatibility.yml/dispatches`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ref: "main",
            inputs: {
              key,
              runtimes: JSON.stringify(runtimes),
              release: release.tag_name,
            },
          }),
        },
      );
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await main();
