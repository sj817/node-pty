import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { versionOf, hash } from '../scripts/common.ts';
import { evaluateChecks } from '../scripts/gate.ts';
import { publishPackages, publishPlan } from '../scripts/publish.ts';
import { shouldTest, latestPerMajor } from '../scripts/detect.ts';
const require = createRequire(import.meta.url);
const { platformId, unpacked } = require('../runtime/loader.cts');

test('runtime checks deduplicate successful and in-flight fingerprints, retry failures', () => {
  assert.equal(shouldTest('abc', [{ display_title: 'abc', status: 'queued' }]), false);
  assert.equal(shouldTest('abc', [{ display_title: 'abc', status: 'completed', conclusion: 'success' }]), false);
  assert.equal(shouldTest('abc', [{ display_title: 'abc', status: 'completed', conclusion: 'failure' }]), true);
  assert.equal(shouldTest('new', [{ display_title: 'abc', status: 'completed', conclusion: 'success' }]), true);
  assert.deepEqual(latestPerMajor(['22.1.0', '22.2.0', '24.1.0', '24.2.0-rc.1'], [22, 24]), ['22.2.0', '24.1.0']);
});

test('version mapping keeps downstream revisions distinct from upstream patches', () => {
  assert.equal(versionOf('1.1.0', 0), '1.1.0');
  assert.equal(versionOf('1.1.0', 2), '1.1.2');
  assert.equal(versionOf('1.1.1', 0), '1.1.1000');
  assert.equal(versionOf('1.2.0-beta.17', 3), '1.2.3-beta.17.r3');
  assert.throws(() => versionOf('main', 0));
  assert.throws(() => versionOf('1.0.0', 1000));
});
test('gate requires exact SHA, provider, name and successful completion', () => {
  const check = { id: 1, name: 'build', head_sha: 'abc', app: { slug: 'azure-pipelines' }, status: 'completed', conclusion: 'success' };
  const evaluate = checks => evaluateChecks('abc', checks, [], ['build']).ready;
  assert.ok(evaluate([check]));
  assert.equal(evaluate([]), false);
  for (const changed of [{ head_sha: 'other' }, { conclusion: 'failure' }, { status: 'in_progress' }, { app: { slug: 'other' } }, { conclusion: 'neutral' }, { conclusion: 'skipped' }]) assert.equal(evaluate([{ ...check, ...changed }]), false);
  assert.equal(evaluate([check, { ...check, id: 2, conclusion: 'failure' }]), false);
  assert.equal(evaluateChecks('abc', [check], [{ context: 'ci', state: 'pending' }], ['build']).ready, false);
});
test('platform selection follows npm vocabulary and identifies libc', () => {
  assert.equal(platformId('win32', 'arm64'), 'win32-arm64');
  assert.equal(platformId('darwin', 'x64'), 'darwin-x64');
  assert.equal(platformId('linux', 'x64', { header: { glibcVersionRuntime: '2.35' } }), 'linux-x64-glibc');
  assert.equal(platformId('linux', 'arm64', { header: {}, sharedObjects: ['/lib/ld-musl-aarch64.so.1'] }), 'linux-arm64-musl');
  assert.throws(() => platformId('linux', 'x64', {}), { code: 'ERR_PTY_LIBC' });
  assert.throws(() => platformId('win32', 'amd64'), { code: 'ERR_PTY_PLATFORM' });
  assert.equal(unpacked('/app/resources/app.asar/node_modules/pkg/bin'), '/app/resources/app.asar.unpacked/node_modules/pkg/bin');
});
test('partial publish retries immutable packages and never exposes main before children', async () => {
  const packages = ['main', 'linux', 'windows'].map(name => ({ name, version: '1.0.0', buildKey: 'key', integrity: hash(name) }));
  const existing: Record<string, any> = {};
  const calls = [];
  let shouldFail = true;
  const adapter = {
    get: async pkg => existing[pkg.name] || null,
    publish: async pkg => {
      calls.push(pkg.name);
      if (pkg.name === 'windows' && shouldFail) throw new Error('temporary registry failure');
      existing[pkg.name] = { dist: { integrity: pkg.integrity }, nodePty: { buildKey: pkg.buildKey } };
    },
    confirm: async pkg => assert.ok(existing[pkg.name]),
    tag: async pkg => calls.push(`tag:${pkg.name}`)
  };
  await publishPackages(packages, adapter, 'main', 'latest', true);
  assert.deepEqual(calls, []);
  await assert.rejects(publishPackages(packages, adapter, 'main', 'latest'));
  assert.equal(existing.main, undefined);
  shouldFail = false;
  await publishPackages(packages, adapter, 'main', 'latest');
  assert.deepEqual(calls, ['linux', 'windows', 'windows', 'main', 'tag:linux', 'tag:windows', 'tag:main']);
  const count = calls.filter(name => name === 'main').length;
  await publishPackages(packages, adapter, 'main', 'latest');
  assert.equal(calls.filter(name => name === 'main').length, count);
  assert.throws(() => publishPlan(packages, { main: { dist: { integrity: 'wrong' } } }, 'main'), /conflict/);
});

test('a child awaiting registry availability blocks the primary package', async () => {
  const packages = ['main', 'linux'].map(name => ({ name, version: '1.0.0', buildKey: 'key', integrity: hash(name) }));
  const published = new Map<string, object>();
  let ready = false;
  const adapter = {
    get: async pkg => published.get(pkg.name) || null,
    publish: async pkg => { published.set(pkg.name, { dist: { integrity: pkg.integrity }, nodePty: { buildKey: pkg.buildKey } }); },
    confirm: async pkg => { if (pkg.name === 'linux' && !ready) throw new Error('tarball still processing'); },
    tag: async () => {}
  };
  await assert.rejects(publishPackages(packages, adapter, 'main', 'latest'), /still processing/);
  assert.equal(published.has('main'), false);
  ready = true;
  await publishPackages(packages, adapter, 'main', 'latest');
  assert.equal(published.has('main'), true);
});
