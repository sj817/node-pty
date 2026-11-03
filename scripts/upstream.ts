import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import semver from "semver";
import { config, githubPages, root, run } from "./common.ts";

const repository = join(root, ".work/upstream-tags.git");
export function upstreamGit(...args: string[]): string {
  return run("git", ["-C", repository, ...args], { capture: true }) || "";
}

export function classifyNativeSource(
  source: string,
): "node-api" | "node-v8" | "unknown" {
  if (
    /\b(?:Nan::|NAN_MODULE_INIT|v8::|NODE_MODULE\s*\(|using namespace v8)/.test(
      source,
    )
  )
    return "node-v8";
  if (
    /\b(?:NODE_API_MODULE|NAPI_MODULE)\s*\(/.test(source) &&
    source.includes("<napi.h>")
  )
    return "node-api";
  return "unknown";
}

export function selectTags(records, minimum: string) {
  return records
    .filter((tag) => semver.gte(tag.version, minimum))
    .sort((a, b) => semver.compare(a.version, b.version));
}

export function diffBase(tag, records) {
  const older = records
    .filter((record) => semver.lt(record.version, tag.version))
    .sort((a, b) => semver.rcompare(a.version, b.version));
  if (semver.prerelease(tag.version)) {
    const core = semver.parse(tag.version);
    const sameLine = older.find((record) => {
      const other = semver.parse(record.version);
      return (
        other.prerelease.length &&
        other.major === core.major &&
        other.minor === core.minor &&
        other.patch === core.patch
      );
    });
    if (sameLine) return sameLine;
  }
  return older.find((record) => !semver.prerelease(record.version));
}

export function changeAreas(paths: string[]): string[] {
  return [
    ...new Set(
      paths.map((path) => {
        if (/^(src\/(unix|win)\/|third_party\/|binding\.gyp$)/.test(path))
          return "native";
        if (path.startsWith("src/")) return "runtime";
        if (path.startsWith("typings/")) return "types";
        if (/^(pipelines\/|publish\.yml|\.github\/)/.test(path)) return "ci";
        if (/^(package|scripts\/)/.test(path)) return "build";
        if (/license/i.test(path)) return "licenses";
        return "other";
      }),
    ),
  ].sort();
}

export function sourceDiff(tag, records) {
  const base = diffBase(tag, records);
  const paths = (
    base
      ? upstreamGit("diff", "--name-only", base.sha, tag.sha)
      : upstreamGit("ls-tree", "-r", "--name-only", tag.sha)
  )
    .split(/\r?\n/)
    .filter(Boolean);
  return {
    baseTag: base?.tag || null,
    baseSha: base?.sha || null,
    areas: changeAreas(paths),
    files: paths,
  };
}

export async function refreshTags(previous) {
  const remote = (
    await githubPages(`repos/${config.upstream.repository}/tags`)
  ).filter((tag) => semver.valid(tag.name));
  for (const tag of remote) {
    const old = previous.find((record) => record.tag === tag.name);
    if (old && old.sha !== tag.commit.sha)
      throw new Error(`MOVED TAG ${tag.name}`);
  }
  for (const old of previous)
    if (!remote.some((tag) => tag.name === old.tag))
      throw new Error(`REMOVED TAG ${old.tag}`);
  mkdirSync(join(root, ".work"), { recursive: true });
  if (!existsSync(repository)) {
    run("git", ["init", "--bare", repository]);
    upstreamGit(
      "remote",
      "add",
      "origin",
      `https://github.com/${config.upstream.repository}.git`,
    );
  }
  run("git", [
    "-C",
    repository,
    "fetch",
    "--filter=blob:none",
    "origin",
    "refs/tags/*:refs/tags/*",
  ]);
  const result = [];
  for (const tag of remote) {
    const sha = upstreamGit("rev-parse", `${tag.name}^{commit}`);
    if (sha !== tag.commit.sha)
      throw new Error(`Tag target differs from API ${tag.name}`);
    const old = previous.find(
      (record) => record.tag === tag.name && record.sha === sha,
    );
    if (
      old?.committedAt &&
      (old.ci || semver.lt(old.version, config.sync.minimumUpstream))
    ) {
      result.push(old);
      continue;
    }
    const paths = upstreamGit("ls-tree", "-r", "--name-only", sha).split(
      /\r?\n/,
    );
    const sourcePath = ["src/unix/pty.cc", "src/pty.cc", "src/ppty.cc"].find(
      (path) => paths.includes(path),
    );
    const pkg = old?.packageVersion
      ? { version: old.packageVersion }
      : JSON.parse(upstreamGit("show", `${sha}:package.json`));
    const record = {
      tag: tag.name,
      sha,
      version: semver.valid(tag.name),
      packageVersion: pkg.version,
      api:
        old?.api ||
        classifyNativeSource(
          sourcePath ? upstreamGit("show", `${sha}:${sourcePath}`) : "",
        ),
      sourcePath,
      committedAt: upstreamGit("show", "-s", "--format=%cI", sha),
      ...(old?.ci ? { ci: { ...old.ci, source: "publish.yml" } } : {}),
    };
    if (
      !record.ci &&
      semver.gte(record.version, config.sync.minimumUpstream) &&
      paths.includes("publish.yml")
    ) {
      const publish = upstreamGit("show", `${sha}:publish.yml`);
      const prebuilds = paths.includes("pipelines/prebuilds.yml")
        ? upstreamGit("show", `${sha}:pipelines/prebuilds.yml`)
        : "";
      const checks = await githubPages(
        `repos/${config.upstream.repository}/commits/${sha}/check-runs?filter=latest`,
        "check_runs",
      );
      const linux = checks.filter(
        (check) =>
          check.app?.slug === config.checkApp &&
          check.head_sha === sha &&
          /^node-pty \(publish\) \(node-pty Linux \(Node\.js [\d.x]+\)\)$/.test(
            check.name,
          ),
      );
      const names = [...new Set(linux.map((check) => check.name))];
      const jobs = [
        "win32_x64",
        "win32_arm64",
        "macOS_x64",
        "macOS_arm64",
        "linux_x64",
        "linux_arm64",
      ];
      if (
        names.length === 1 &&
        publish.includes(
          "azure-pipelines/npm-package/pipeline.yml@templates",
        ) &&
        publish.includes("npm test") &&
        publish.includes("npm run lint") &&
        jobs.every((job) => prebuilds.includes(`job: ${job}`))
      ) {
        record.ci = {
          app: config.checkApp,
          source: "publish.yml",
          nodeVersion: names[0].match(/Node\.js ([\d.x]+)/)[1],
          linuxCheck: names[0],
        };
      }
    }
    result.push(record);
  }
  return result.sort((a, b) => semver.rcompare(a.version, b.version));
}
