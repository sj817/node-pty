import { cpSync, mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { config, root, run, files, hash, integrity, writeJson, readJson, version, buildKey, currentPlatform, packageName } from './common.ts';

const platform = currentPlatform();
const key = buildKey();
const work = join(root, '.work', platform.id);
const source = join(work, 'upstream');
const out = join(root, 'dist', platform.id);
mkdirSync(work, { recursive: true });
mkdirSync(out, { recursive: true });
if (!existsSync(join(source, '.git'))) {
  run('git', ['init', source]);
  run('git', ['remote', 'add', 'origin', `https://github.com/${config.upstream.repository}.git`], { cwd: source });
}
run('git', ['fetch', '--depth=1', 'origin', config.upstream.sha], { cwd: source });
run('git', ['checkout', '--detach', config.upstream.sha], { cwd: source });
if (run('git', ['rev-parse', 'HEAD'], { cwd: source, capture: true }) !== config.upstream.sha) throw new Error('Source SHA mismatch');
if (readJson(join(source, 'package.json')).version !== config.upstream.version) throw new Error('Source version mismatch');
// Restore only the file modified by this script on retries. Never touch user worktrees.
run('git', ['restore', '--source=HEAD', '--', 'binding.gyp', 'src/tsconfig.json', 'package-lock.json'], { cwd: source });
let binding = readFileSync(join(source, 'binding.gyp'), 'utf8');
if (!binding.includes("'target_defaults': {")) throw new Error('Upstream build structure changed. Review adapter.');
binding = binding.replace("'target_defaults': {", `'target_defaults': {\n    'defines': ['NAPI_VERSION=${config.napi}'],`);
if (platform.os === 'darwin') binding = binding.replace('"MACOSX_DEPLOYMENT_TARGET":"10.7"', `"MACOSX_DEPLOYMENT_TARGET":"${platform.deploymentTarget}"`);
writeFileSync(join(source, 'binding.gyp'), binding);
const tsconfig = readJson(join(source, 'src/tsconfig.json'));
tsconfig.compilerOptions.newLine = 'lf';
writeJson(join(source, 'src/tsconfig.json'), tsconfig);
// Upstream 1.1.0 omitted chokidar's optional macOS dependency from its lockfile.
// Add its registry-verified immutable entry so modern npm ci can validate the lock.
const lock = readJson(join(source, 'package-lock.json'));
if (!lock.packages['node_modules/fsevents']) {
  lock.packages['node_modules/fsevents'] = {
    version: '2.3.3',
    resolved: 'https://registry.npmjs.org/fsevents/-/fsevents-2.3.3.tgz',
    integrity: 'sha512-5xoDfX+fL7faATnagmWPpbFtwh/R77WmMMqqHGS65C3vvB0YHrgF+B1YmZ3441tMj5n63k0212XNoJwzlhffQw==',
    dev: true, optional: true, hasInstallScript: true, os: ['darwin'],
    engines: { node: '^8.16.0 || ^10.6.0 || >=11.0.0' }
  };
}
writeJson(join(source, 'package-lock.json'), lock);
const env = { ...process.env, npm_config_arch: platform.cpu, ...(platform.deploymentTarget ? { MACOSX_DEPLOYMENT_TARGET: platform.deploymentTarget } : {}) };
run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: source, env });
// Upstream's node-gyp 11 cannot detect VS 2026 on windows-11-arm.
if (platform.id === 'win32-arm64') run('npm', ['install', '--no-save', '--no-package-lock', '--ignore-scripts', '--no-audit', '--no-fund', `node-gyp@${config.windowsArmNodeGyp}`], { cwd: source, env });
run(process.execPath, [join(source, 'node_modules/node-gyp/bin/node-gyp.js'), 'rebuild', `--target=${config.buildNode}`, `--arch=${platform.cpu}`], { cwd: source, env });
run('npm', ['run', 'build'], { cwd: source, env });
run(process.execPath, ['scripts/post-install.js'], { cwd: source, env });

const metadata = { upstream: config.upstream, revision: config.revision, napi: config.napi, buildKey: key };
const base = { version, description: 'Prebuilt distribution of microsoft/node-pty', license: 'MIT', repository: { type: 'git', url: `git+https://github.com/${config.repository}.git` }, homepage: `https://github.com/${config.repository}#readme`, bugs: { url: `https://github.com/${config.repository}/issues` }, publishConfig: { access: 'public' }, engines: { node: '>=22.14.0' } };

function stage(name) {
  const dir = join(work, 'packages', name);
  if (existsSync(dir)) throw new Error(`Staging directory already exists: ${dir}. Remove .work/${platform.id}/packages before rebuilding.`);
  mkdirSync(dir, { recursive: true });
  cpSync(join(root, 'LICENSE'), join(dir, 'LICENSE'));
  cpSync(join(root, 'licenses'), join(dir, 'licenses'), { recursive: true });
  cpSync(join(source, 'node_modules/node-addon-api/LICENSE.md'), join(dir, 'licenses/node-addon-api.md'));
  return dir;
}
const main = stage('main');
mkdirSync(join(main, 'lib'), { recursive: true });
for (const file of files(join(source, 'lib'))) {
  if (!file.endsWith('.js') || file.endsWith('.test.js') || file.startsWith('test/')) continue;
  mkdirSync(join(main, 'lib', file, '..'), { recursive: true });
  cpSync(join(source, 'lib', file), join(main, 'lib', file));
}
const utilsPath = join(main, 'lib/utils.js');
const utils = readFileSync(utilsPath, 'utf8');
if (!utils.includes('function loadNativeModule(name)')) throw new Error('Upstream loader changed. Review adapter.');
// Replace only the exported native loader. All upstream PTY classes stay intact.
writeFileSync(utilsPath, utils + '\nexports.loadNativeModule = require("../loader.cjs").loadNativeModule;\n');
for (const [input, output] of [['runtime/loader.cts', 'loader.cjs'], ['runtime/entry.cts', 'index.cjs']]) {
  const sourceText = readFileSync(join(root, input), 'utf8');
  const compiled = ts.transpileModule(sourceText, { fileName: input, compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
  writeFileSync(join(main, output), compiled.outputText);
}
cpSync(join(root, 'README.md'), join(main, 'README.md'));
const declaration = readFileSync(join(source, 'typings/node-pty.d.ts'), 'utf8').replace(/\r\n/g, '\n');
if (!declaration.includes("declare module 'node-pty'")) throw new Error('Upstream declarations changed');
writeFileSync(join(main, 'index.d.ts'), declaration.replace("declare module 'node-pty'", `declare module '${config.package}'`));
writeJson(join(main, 'package.json'), { ...base, name: config.package, main: 'index.cjs', types: 'index.d.ts', files: ['lib', 'index.cjs', 'index.d.ts', 'loader.cjs', 'licenses', 'SOURCE.json'], optionalDependencies: Object.fromEntries(config.platforms.map(p => [packageName(p), version])), nodePty: metadata });
writeJson(join(main, 'SOURCE.json'), { ...metadata, buildNode: config.buildNode, platforms: config.platforms, modifications: ['Fixed NAPI_VERSION', 'Native module resolution via exact optional platform packages', 'ASAR-unpacked entry point', 'TypeScript ambient module renamed to @qwqo/node-pty'] });

const native = stage(platform.id);
const binaries = platform.os === 'win32'
  ? ['conpty.node', 'conpty_console_list.node', 'pty.node', 'winpty-agent.exe', 'winpty.dll', 'conpty/conpty.dll', 'conpty/OpenConsole.exe']
  : platform.os === 'darwin' ? ['pty.node', 'spawn-helper'] : ['pty.node'];
for (const file of binaries) {
  const target = join(native, 'bin', file);
  mkdirSync(join(target, '..'), { recursive: true });
  cpSync(join(source, 'build/Release', file), target);
  if (file === 'spawn-helper') chmodSync(target, 0o755);
}
writeJson(join(native, 'package.json'), { ...base, name: packageName(platform), os: [platform.os], cpu: [platform.cpu], ...(platform.libc ? { libc: [platform.libc] } : {}), files: ['bin', 'licenses', 'SOURCE.json'], nodePty: { ...metadata, platform: platform.id, glibc: platform.glibc } });
writeFileSync(join(native, 'README.md'), `# ${packageName(platform)}\n\nNative assets for ${config.package}@${version}. Install the main package.\n\nMinimum target ${platform.minimumOS}. Built from ${config.upstream.repository}@${config.upstream.sha}.\n`);
writeJson(join(native, 'SOURCE.json'), { ...metadata, platform, buildNode: config.buildNode, nodeGyp: readJson(join(source, 'node_modules/node-gyp/package.json')).version, buildEnvironment: { node: process.version, os: process.platform, arch: process.arch, runnerImage: process.env.ImageOS || 'local', runnerImageVersion: process.env.ImageVersion || 'local' }, bindingSha256: hash(binding), files: Object.fromEntries(binaries.map(file => [file, hash(readFileSync(join(native, 'bin', file)))])) });

const packages = [];
for (const dir of [native, main]) {
  const packed = JSON.parse(run('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', out], { cwd: dir, capture: true }))[0];
  if (packed.files.some(f => /(?:\.pdb$|binding\.gyp$|\.cc$|\.map$|\.test\.js$)/.test(f.path))) throw new Error('Unexpected build input in tarball');
  const manifest = readJson(join(dir, 'package.json'));
  packages.push({ name: manifest.name, version, filename: packed.filename, integrity: integrity(join(out, packed.filename)), sha256: hash(readFileSync(join(out, packed.filename))) });
}
writeJson(join(out, 'build.json'), { platform: platform.id, buildKey: key, upstream: config.upstream, version, packages });
console.log(`Built ${platform.id} / ${version} / ${key}`);
