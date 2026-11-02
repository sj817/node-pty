import assert from 'node:assert/strict';
import { mkdirSync, cpSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { config, root, readJson, writeJson, version, buildKey, integrity, packageName, hash } from './common.mjs';

const key = buildKey();
const dir = join(root, 'dist/bundle');
mkdirSync(dir, { recursive: true });
const packages = new Map();
const verification = [];
for (const platform of config.platforms) {
  const source = join(root, 'dist', platform.id);
  const proof = readJson(join(source, 'verified.json'));
  assert.equal(proof.platform, platform.id);
  assert.equal(proof.version, version);
  assert.equal(proof.buildKey, key);
  assert.deepEqual(proof.runtimes, config.runtimes);
  for (const node of config.runtimes.node) assert.ok(proof.results.some(r => r.kind === 'node' && r.version === node && r.ok));
  for (const electron of config.runtimes.electron) for (const asar of [false, true]) assert.ok(proof.results.some(r => r.kind === 'electron' && r.version === electron && r.asar === asar && r.ok));
  for (const manager of ['npm', 'pnpm']) assert.ok(proof.results.some(r => r.kind === 'installation' && r.manager === manager && r.types && r.ok));
  assert.ok(proof.results.some(r => r.kind === 'omit-optional' && r.ok));
  assert.deepEqual(proof.packages.map(p => p.name).sort(), [config.package, packageName(platform)].sort());
  for (const pkg of proof.packages) {
    assert.equal(integrity(join(source, pkg.filename)), pkg.integrity);
    if (packages.has(pkg.name)) assert.equal(packages.get(pkg.name).integrity, pkg.integrity, `Nonidentical main package from ${platform.id}`);
    packages.set(pkg.name, { ...pkg, buildKey: key });
    cpSync(join(source, pkg.filename), join(dir, pkg.filename));
  }
  verification.push(proof);
}
const manifest = { repository: config.repository, version, buildKey: key, upstream: config.upstream, sourceCommit: process.env.GITHUB_SHA || null, packages: [...packages.values()].sort((a, b) => a.name.localeCompare(b.name)), verification };
writeJson(join(dir, 'release-manifest.json'), manifest);
console.log(`Assembled ${packages.size} packages, manifest SHA256 ${hash(readFileSync(join(dir, 'release-manifest.json')))}`);
