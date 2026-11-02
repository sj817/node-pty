import { join } from 'node:path';
import { mkdirSync, cpSync } from 'node:fs';
import { config, root, packageName, writeJson } from './common.ts';

// These are discovery manifests for the installed npt CLI, never release packages.
const dir = join(root, '.work/trust');
for (const name of [config.package, ...config.platforms.map(packageName)]) {
  const target = join(dir, name.split('/')[1]);
  mkdirSync(join(target, '.github/workflows'), { recursive: true });
  writeJson(join(target, 'package.json'), { name, version: '0.0.1', repository: { type: 'git', url: `git+https://github.com/${config.repository}.git` } });
  cpSync(join(root, '.github/workflows/publish.yml'), join(target, '.github/workflows/publish.yml'));
  console.log(`${name} -> github:${config.repository}@${config.workflow} environment=${config.environment}`);
}
console.log(`npt scan --dir "${dir}" --workflow ${config.workflow} --environment ${config.environment} --allow-dist-tag`);
console.log(`npt sync --dir "${dir}" --workflow ${config.workflow} --environment ${config.environment} --allow-dist-tag --placeholder --placeholder-tag bootstrap --dry-run`);
