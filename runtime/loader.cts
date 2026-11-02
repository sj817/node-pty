'use strict';
const fs = require('node:fs');
const path = require('node:path');

type RuntimeReport = { header?: { glibcVersionRuntime?: string }; sharedObjects?: string[] };

function fail(code: string, message: string, cause?: unknown): never {
  const error = new Error(`@qwqo/node-pty: ${message}`, { cause }) as Error & { code: string };
  error.code = code;
  throw error;
}

function platformId(platform: string, arch: string, report?: RuntimeReport): string {
  if (!['win32', 'darwin', 'linux'].includes(platform) || !['x64', 'arm64'].includes(arch)) {
    fail('ERR_PTY_PLATFORM', `unsupported platform ${platform}-${arch}. See the published compatibility matrix.`);
  }
  if (platform !== 'linux') return `${platform}-${arch}`;
  if (report?.header?.glibcVersionRuntime) return `linux-${arch}-glibc`;
  const objects = report?.sharedObjects || [];
  if (objects.some(file => /(?:ld-musl|libc\.musl)/.test(file))) return `linux-${arch}-musl`;
  fail('ERR_PTY_LIBC', 'cannot identify Linux libc. A glibc runtime or an explicitly supported musl build is required.');
}

function unpacked(file: string): string {
  return file.replace(/([\\/][^\\/]+\.asar)(?=[\\/])/g, '$1.unpacked');
}

function loadNativeModule(name: string) {
  const manifest = require('./package.json');
  const report = process.platform === 'linux' ? process.report.getReport() as RuntimeReport : undefined;
  const id = platformId(process.platform, process.arch, report);
  const expected = `@qwqo/node-pty-${id}`;
  const expectedVersion = manifest.optionalDependencies[expected];
  if (!expectedVersion) fail('ERR_PTY_PLATFORM', `${id} is not included in ${manifest.version}. See the published compatibility matrix.`);
  if (Number(process.versions.napi || 0) < manifest.nodePty.napi) {
    fail('ERR_PTY_NAPI', `Node-API ${manifest.nodePty.napi}+ is required. Runtime provides ${process.versions.napi || 'none'} (${process.versions.electron ? 'Electron ' + process.versions.electron : 'Node ' + process.versions.node}).`);
  }
  let metadataPath;
  try {
    metadataPath = require.resolve(`${expected}/package.json`);
  } catch (cause) {
    fail('ERR_PTY_MISSING_PACKAGE', `missing ${expected}@${expectedVersion}. Install with optional dependencies enabled (npm install --include=optional). Check --omit=optional, --no-optional, the lockfile, and whether node_modules was copied from another OS/architecture.`, cause);
  }
  const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
  if (metadata.version !== expectedVersion || metadata.nodePty.platform !== id || metadata.nodePty.buildKey !== manifest.nodePty.buildKey) {
    fail('ERR_PTY_PACKAGE_MISMATCH', `${expected} has incompatible version, architecture or build metadata. Expected ${expectedVersion} / ${id}. Reinstall for this runtime's architecture.`);
  }
  const glibc = report?.header?.glibcVersionRuntime;
  const requiredGlibc = metadata.nodePty.glibc;
  if (glibc && requiredGlibc) {
    const actual = glibc.split('.').map(Number);
    const minimum = requiredGlibc.split('.').map(Number);
    if (actual[0] < minimum[0] || (actual[0] === minimum[0] && actual[1] < minimum[1])) fail('ERR_PTY_GLIBC', `glibc ${requiredGlibc}+ is required, found ${glibc}.`);
  }
  const dir = unpacked(path.join(path.dirname(metadataPath), 'bin'));
  const file = path.join(dir, `${name}.node`);
  if (!fs.existsSync(file)) fail('ERR_PTY_BINARY_MISSING', `missing ${file}. In Electron, unpack the complete @qwqo/node-pty* packages from ASAR, including helpers and DLLs.`);
  try {
    return { dir, module: require(file) };
  } catch (cause) {
    fail('ERR_PTY_NATIVE_LOAD', `cannot load ${file} on ${process.platform}-${process.arch}, Node ${process.versions.node}, Node-API ${process.versions.napi}, Electron ${process.versions.electron || 'none'}. Check OS version, shared libraries and package architecture. ${cause.message}`, cause);
  }
}
module.exports = { loadNativeModule, platformId, unpacked };
