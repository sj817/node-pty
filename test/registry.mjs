import http from 'node:http';
import { readFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { run, readJson } from '../scripts/common.mjs';

const dir = process.argv[2];
const build = readJson(join(dir, 'build.json'));
const manifests = new Map();
for (const pkg of build.packages) {
  const manifest = JSON.parse(run('tar', ['-xOf', join(dir, pkg.filename), 'package/package.json'], { capture: true }));
  manifests.set(pkg.name, { pkg, manifest });
}
const server = http.createServer((req, res) => {
  const name = decodeURIComponent(req.url.slice(1));
  if (name.startsWith('tarballs/')) {
    const filename = basename(name);
    if (!build.packages.some(p => p.filename === filename)) { res.writeHead(404).end(); return; }
    res.setHeader('Content-Type', 'application/octet-stream');
    res.end(readFileSync(join(dir, filename)));
    return;
  }
  const entry = manifests.get(name);
  if (!entry) { res.writeHead(404).end(JSON.stringify({ error: 'not_found' })); return; }
  const { pkg, manifest } = entry;
  const record = { ...manifest, dist: { integrity: pkg.integrity, tarball: `http://127.0.0.1:${server.address().port}/tarballs/${pkg.filename}` } };
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ name: pkg.name, 'dist-tags': { latest: pkg.version }, versions: { [pkg.version]: record } }));
});
server.listen(0, '127.0.0.1', () => process.send({ port: server.address().port }));
