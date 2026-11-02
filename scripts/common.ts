import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

export const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const config = JSON.parse(
  readFileSync(join(root, "release.json"), "utf8"),
);
if (process.env.UPSTREAM_TAG) {
  const tags = JSON.parse(
    readFileSync(join(root, "upstream-tags.json"), "utf8"),
  );
  const selected = tags.find((tag) => tag.tag === process.env.UPSTREAM_TAG);
  if (!selected)
    throw new Error("Upstream tag is not locked in upstream-tags.json");
  config.upstream = {
    repository: config.upstream.repository,
    tag: selected.tag,
    sha: selected.sha,
    version: selected.version,
    sourceVersion: selected.packageVersion || selected.version,
  };
}
if (process.env.TEST_VERSION)
  config.publication.version = process.env.TEST_VERSION;
// Keep metadata bytes identical for default and explicitly selected tags.
config.upstream = {
  repository: config.upstream.repository,
  tag: config.upstream.tag,
  version: config.upstream.version,
  sha: config.upstream.sha,
  sourceVersion: config.upstream.sourceVersion || config.upstream.version,
};
export const readJson = (file: string) =>
  JSON.parse(readFileSync(file, "utf8"));
export function writeJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
}
export const hash = (value: string | Buffer): string =>
  createHash("sha256").update(value).digest("hex");
export const integrity = (file: string): string =>
  "sha512-" + createHash("sha512").update(readFileSync(file)).digest("base64");
export function run(
  command: string,
  args: string[],
  options: { capture?: boolean; cwd?: string; env?: NodeJS.ProcessEnv } = {},
): string | undefined {
  const { capture = false, ...rest } = options;
  // npm's JS entry point avoids cmd.exe quoting and works with paths containing spaces.
  if (command === "npm") {
    const npmCli =
      process.env.npm_execpath ||
      join(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js");
    if (process.platform === "win32") {
      args = [npmCli, ...args];
      command = process.execPath;
    }
  }
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    stdio: capture ? "pipe" : "inherit",
    timeout: 1200000,
    ...rest,
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(
      `${command} failed (${result.status})\n${result.stderr || ""}\n${result.stdout || ""}`,
    );
  return result.stdout?.trim();
}
export function files(dir: string, prefix = ""): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) => {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      return entry.isDirectory() ? files(join(dir, entry.name), path) : [path];
    });
}
export function assertTestPublication(value: string, tag: string): void {
  if (!/^0\.0\.(?:[1-9]|[1-9][0-9]|100)$/.test(value) || tag !== "next") {
    throw new Error(
      "Publishing is restricted to 0.0.1 through 0.0.100 under the next tag",
    );
  }
}
export const version = config.publication.version;
assertTestPublication(version, config.publication.tag);
export const releasePlatforms = config.platforms.filter((p) => p.publish);
export function buildKey() {
  const paths = [
    "package-lock.json",
    "scripts/build.ts",
    "scripts/adapt.ts",
    "scripts/common.ts",
    "runtime/loader.ts",
    "runtime/entry.ts",
    "LICENSE",
    "README.md",
    ...files(join(root, "licenses")).map((p) => `licenses/${p}`),
  ];
  return hash(
    JSON.stringify({
      upstream: config.upstream,
      version,
      napi: config.napi,
      node: config.buildNode,
      windowsArmNodeGyp: config.windowsArmNodeGyp,
      platforms: config.platforms,
      files: paths.map((p) => [
        p,
        hash(readFileSync(join(root, p), "utf8").replace(/\r\n/g, "\n")),
      ]),
    }),
  );
}
type RequestOptions = {
  allow404?: boolean;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
};
export async function jsonRequest(url: string, options: RequestOptions = {}) {
  const response = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(45000),
  });
  if (response.status === 404 && options.allow404) return null;
  if (!response.ok)
    throw new Error(
      `HTTP ${response.status} from ${new URL(url).origin}${new URL(url).pathname}`,
    );
  if (response.status === 204) return null;
  return response.json();
}
export async function github(path: string, options: RequestOptions = {}) {
  return jsonRequest(`https://api.github.com/${path}`, {
    ...options,
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(process.env.GH_TOKEN
        ? { Authorization: `Bearer ${process.env.GH_TOKEN}` }
        : {}),
      ...options.headers,
    },
  });
}
export async function githubPages(path: string, property?: string) {
  const result = [];
  for (let page = 1; ; page++) {
    const data = await github(
      `${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`,
    );
    const rows = property ? data[property] : data;
    result.push(...rows);
    if (rows.length < 100) return result;
  }
}
export const packageName = (platform: { id: string }): string =>
  `${config.package}-${platform.id}`;
export function currentPlatform() {
  if (process.env.TARGET_PLATFORM) {
    const target = config.platforms.find(
      (p) => p.id === process.env.TARGET_PLATFORM,
    );
    if (!target) throw new Error("Unknown target platform");
    return target;
  }
  const report =
    process.platform === "linux"
      ? (process.report.getReport() as {
          header: { glibcVersionRuntime?: string };
        })
      : undefined;
  const libc = report
    ? report.header.glibcVersionRuntime
      ? "glibc"
      : "musl"
    : undefined;
  const platform = config.platforms.find(
    (p) =>
      p.os === process.platform && p.cpu === process.arch && p.libc === libc,
  );
  if (!platform)
    throw new Error(
      `Unsupported build host ${process.platform}-${process.arch}-${libc || ""}`,
    );
  return platform;
}
