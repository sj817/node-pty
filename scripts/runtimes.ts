import { readFileSync } from "node:fs";
import { join } from "node:path";
import semver from "semver";
import { config, hash, jsonRequest, root } from "./common.ts";

export function latestPerMajor(versions: string[], majors: number[]): string[] {
  return majors
    .map(
      (major) =>
        versions
          .filter(
            (value) =>
              semver.valid(value) &&
              !semver.prerelease(value) &&
              semver.major(value) === major,
          )
          .sort(semver.rcompare)[0],
    )
    .filter(Boolean);
}

export function hasRuntimeUpdates(configured, discovered): boolean {
  return ["node", "electron"].some((kind) =>
    discovered[kind].some((value) => !configured[kind].includes(value)),
  );
}

export function verificationRecipe(): string {
  return hash(
    JSON.stringify({
      androidRuntime: config.androidRuntime,
      files: [
        "scripts/verify.ts",
        "scripts/container.ts",
        "scripts/retest.ts",
        "scripts/runtimes.ts",
        "scripts/android-container.ts",
        "test/smoke.ts",
        "test/types.ts",
        "test/types.cts",
        "test/registry.ts",
        "package-lock.json",
      ].map((file) => [
        file,
        hash(readFileSync(join(root, file), "utf8").replace(/\r\n/g, "\n")),
      ]),
    }),
  );
}

export function compatibilityKey(upstream, version: string, runtimes): string {
  return `compatibility-${hash(JSON.stringify({ upstream, version, runtimes, verificationRecipe: verificationRecipe() })).slice(0, 24)}`;
}

export async function discoverRuntimes() {
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
    .filter(([, period]) => period.start <= today && period.end >= today)
    .map(([name]) => Number(name.slice(1)));
  const electrons = electronIndex
    .map((release) => release.version)
    .filter((value) => semver.valid(value) && !semver.prerelease(value));
  const electronMajors = [
    ...new Set<number>(electrons.map((value) => semver.major(value))),
  ]
    .sort((a, b) => b - a)
    .slice(0, 3)
    .sort((a, b) => a - b);
  return {
    node: latestPerMajor(
      nodeIndex.map((release) => release.version.replace(/^v/, "")),
      majors,
    ),
    electron: latestPerMajor(electrons, electronMajors),
  };
}

export async function muslImages(versions: string[]): Promise<string[]> {
  const auth = await jsonRequest(
    "https://auth.docker.io/token?service=registry.docker.io&scope=repository:library/node:pull",
  );
  return Promise.all(
    versions.map(async (version) => {
      const response = await fetch(
        `https://registry-1.docker.io/v2/library/node/manifests/${version}-alpine`,
        {
          headers: {
            Authorization: `Bearer ${auth.token}`,
            Accept:
              "application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json",
          },
          signal: AbortSignal.timeout(45000),
        },
      );
      if (!response.ok)
        throw new Error(
          `Node ${version} Alpine image is pending (HTTP ${response.status})`,
        );
      const digest = response.headers.get("docker-content-digest");
      const index = await response.json();
      if (
        !/^sha256:[a-f0-9]{64}$/.test(digest) ||
        !["amd64", "arm64"].every((arch) =>
          index.manifests?.some(
            (manifest) =>
              manifest.platform?.os === "linux" &&
              manifest.platform?.architecture === arch,
          ),
        )
      )
        throw new Error(
          `Node ${version} Alpine image lacks an immutable x64/arm64 manifest`,
        );
      return `node@${digest}`;
    }),
  );
}
