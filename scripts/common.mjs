import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const config = JSON.parse(readFileSync(join(root, 'release.json'), 'utf8'));
export const readJson = file => JSON.parse(readFileSync(file, 'utf8'));
export function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}
export const hash = value => createHash('sha256').update(value).digest('hex');
export const integrity = file => 'sha512-' + createHash('sha512').update(readFileSync(file)).digest('base64');
export function run(command, args, options = {}) {
  const { capture = false, ...rest } = options;
  // npm's JS entry point avoids cmd.exe quoting and works with paths containing spaces.
  if (command === 'npm') {
    const npmCli = process.env.npm_execpath || join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
    if (process.platform === 'win32') {
      args = [npmCli, ...args];
      command = process.execPath;
    }
  }
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit', timeout: 1200000, ...rest });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.status})\n${result.stderr || ''}\n${result.stdout || ''}`);
  return result.stdout?.trim();
}
export function files(dir, prefix = '') {
  return readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    return entry.isDirectory() ? files(join(dir, entry.name), path) : [path];
  });
}
export function versionOf(upstream, revision) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(upstream);
  if (!match || !Number.isInteger(revision) || revision < 0 || revision >= 1000) throw new Error('Invalid upstream version or revision (0..999)');
  const [, major, minor, patch, pre] = match;
  return `${major}.${minor}.${Number(patch) * 1000 + revision}${pre ? `-${pre}.r${revision}` : ''}`;
}
export const version = versionOf(config.upstream.version, config.revision);
export function buildKey() {
  const paths = ['package-lock.json', 'scripts/build.mjs', 'scripts/common.mjs', 'runtime/loader.cjs', 'runtime/entry.cjs', 'LICENSE', 'README.md', ...files(join(root, 'licenses')).map(p => `licenses/${p}`)];
  return hash(JSON.stringify({ upstream: config.upstream, revision: config.revision, napi: config.napi, node: config.buildNode, platforms: config.platforms, files: paths.map(p => [p, hash(readFileSync(join(root, p)))]) }));
}
export async function jsonRequest(url, options = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(45000) });
  if (response.status === 404 && options.allow404) return null;
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${new URL(url).origin}${new URL(url).pathname}`);
  if (response.status === 204) return null;
  return response.json();
}
export async function github(path, options = {}) {
  return jsonRequest(`https://api.github.com/${path}`, {
    ...options,
    headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...(process.env.GH_TOKEN ? { Authorization: `Bearer ${process.env.GH_TOKEN}` } : {}), ...options.headers }
  });
}
export async function githubPages(path, property) {
  const result = [];
  for (let page = 1; ; page++) {
    const data = await github(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
    const rows = property ? data[property] : data;
    result.push(...rows);
    if (rows.length < 100) return result;
  }
}
export const packageName = platform => `${config.package}-${platform.id}`;
export function currentPlatform() {
  const libc = process.platform === 'linux' ? (process.report.getReport().header.glibcVersionRuntime ? 'glibc' : 'musl') : undefined;
  const platform = config.platforms.find(p => p.os === process.platform && p.cpu === process.arch && p.libc === libc);
  if (!platform) throw new Error(`Unsupported build host ${process.platform}-${process.arch}-${libc || ''}`);
  return platform;
}
