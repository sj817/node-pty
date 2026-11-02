import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { config, root, readJson, run, integrity, jsonRequest, version, buildKey } from './common.mjs';
import { gate } from './gate.mjs';

export function publishPlan(packages, existing, primary) {
  const conflicts = packages.filter(pkg => existing[pkg.name] && (existing[pkg.name].dist?.integrity !== pkg.integrity || existing[pkg.name].nodePty?.buildKey !== pkg.buildKey));
  if (conflicts.length) throw new Error(`Immutable npm version conflict: ${conflicts.map(p => `${p.name}@${p.version}`).join(', ')}`);
  return [...packages.filter(p => p.name !== primary), ...packages.filter(p => p.name === primary)].map(pkg => ({ ...pkg, action: existing[pkg.name] ? 'verify' : 'publish' }));
}
export async function publishPackages(packages, adapter, primary, tag, dryRun = false) {
  const existing = Object.fromEntries(await Promise.all(packages.map(async pkg => [pkg.name, await adapter.get(pkg)])));
  const plan = publishPlan(packages, existing, primary);
  if (dryRun) return plan;
  for (const pkg of plan) {
    if (pkg.action === 'publish') await adapter.publish(pkg);
    await adapter.confirm(pkg);
  }
  // Main package is tagged last. A retry verifies all immutable bytes first.
  for (const pkg of plan) await adapter.tag(pkg, tag);
  return plan;
}

async function main() {
  const dir = resolve(process.env.BUNDLE_DIR || join(root, 'dist/bundle'));
  const manifest = readJson(join(dir, 'release-manifest.json'));
  if (manifest.version !== version || manifest.buildKey !== buildKey() || manifest.repository !== config.repository) throw new Error('Release manifest does not match checked-out source/configuration');
  const gateResult = await gate();
  if (!gateResult.ready) throw new Error(`Upstream quality gate pending: ${gateResult.reasons.join('; ')}`);
  for (const pkg of manifest.packages) if (integrity(join(dir, pkg.filename)) !== pkg.integrity) throw new Error(`Artifact checksum mismatch ${pkg.name}`);
  const registry = 'https://registry.npmjs.org';
  const adapter = {
    get: pkg => jsonRequest(`${registry}/${encodeURIComponent(pkg.name)}/${pkg.version}`, { allow404: true }),
    publish: async pkg => {
      run('npm', ['publish', join(dir, pkg.filename), '--ignore-scripts', '--access', 'public', '--provenance', '--tag', 'candidate', '--registry', registry]);
    },
    confirm: async pkg => {
      for (let attempt = 0; attempt < 12; attempt++) {
        const record = await adapter.get(pkg);
        if (record) {
          publishPlan([pkg], { [pkg.name]: record }, config.package);
          const response = await fetch(record.dist.tarball, { signal: AbortSignal.timeout(120000) });
          if (!response.ok) throw new Error(`Tarball unavailable ${pkg.name}`);
          const { createHash } = await import('node:crypto');
          const actual = 'sha512-' + createHash('sha512').update(Buffer.from(await response.arrayBuffer())).digest('base64');
          if (actual !== pkg.integrity) throw new Error(`Registry tarball conflict ${pkg.name}`);
          if (!record.dist.attestations?.url) throw new Error(`Missing npm provenance for ${pkg.name}@${pkg.version}`);
          return;
        }
        await new Promise(resolve => setTimeout(resolve, 5000));
      }
      throw new Error(`Registry did not expose ${pkg.name}@${pkg.version}`);
    },
    tag: async (pkg, tag) => {
      const tags = await jsonRequest(`${registry}/-/package/${encodeURIComponent(pkg.name)}/dist-tags`);
      if (tags[tag] === pkg.version) return;
      const { default: semver } = await import('semver');
      if (tags[tag] && semver.gt(tags[tag], pkg.version)) throw new Error(`Refusing to move ${pkg.name}:${tag} backwards from ${tags[tag]}`);
      run('npm', ['dist-tag', 'add', `${pkg.name}@${pkg.version}`, tag, '--registry', registry]);
    }
  };
  const plan = await publishPackages(manifest.packages, adapter, config.package, config.upstream.version.includes('-') ? 'next' : 'latest', process.argv.includes('--dry-run'));
  console.log(JSON.stringify(plan, null, 2));
}
if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();
