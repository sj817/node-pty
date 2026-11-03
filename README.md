# @qwqo/node-pty

Cross-platform prebuilt distribution of [microsoft/node-pty](https://github.com/microsoft/node-pty) for Node.js and Electron. Preserves the upstream API and TypeScript declarations, with native binaries and required helpers delivered through npm.

## Replace node-pty

Use an [npm alias](https://docs.npmjs.com/cli/v11/commands/npm-install#description) to replace an existing direct dependency. Existing `import` and `require("node-pty")` calls continue to work.

```sh
# npm
npm install --save-exact node-pty@npm:@qwqo/node-pty@latest

# pnpm
pnpm add --save-exact node-pty@npm:@qwqo/node-pty@latest
```

For upstream prereleases:

```sh
npm install --save-exact node-pty@npm:@qwqo/node-pty@next
```

Aliases apply to your direct dependency. Replacing transitive dependencies requires your package manager's overrides.

TypeScript aliases require stable `1.1.2` or the corrected beta `1.2.0-beta.17.1` and subsequent releases. The npm commands pin the selected version; keep your package manager's lockfile committed.

For a new project, you can also install the scoped package directly:

```sh
npm install @qwqo/node-pty
# or
pnpm add @qwqo/node-pty
```

Keep optional dependencies enabled. The package works with installation scripts disabled (`--ignore-scripts`).

## Usage

```ts
import { spawn } from "node-pty";

const shell =
  process.platform === "win32"
    ? "cmd.exe"
    : process.env.SHELL ||
      (process.platform === "android" ? "/system/bin/sh" : "/bin/sh");
const terminal = spawn(shell, [], {
  cols: 80,
  rows: 24,
  env: process.env,
});
terminal.onData((data) => process.stdout.write(data));
terminal.onExit(({ exitCode }) => console.log(exitCode));
terminal.write("echo hello\r");
terminal.resize(100, 40);
```

With a direct scoped installation, import from `@qwqo/node-pty` instead. Named imports, default imports and synchronous `require()` are supported. See the [upstream API](https://github.com/microsoft/node-pty#example-usage) for options and events.

## Compatibility

Requires **Node.js 22.14+** and **Node-API 8**. CI covers Node 22, 24 and 26, plus Electron 43, 44 and 45 on desktop platforms. On the tested desktop targets, Node and Electron share the same binary.

| Platform    | Architectures | Addon baseline    | Runtime checks |
| ----------- | ------------- | ----------------- | -------------- |
| Windows     | x64           | Windows 10 22H2   | Node, Electron |
| Windows     | arm64         | Windows 11        | Node, Electron |
| macOS       | x64, arm64    | macOS 13 target   | Node, Electron |
| Linux glibc | x64, arm64    | glibc 2.28        | Node, Electron |
| Linux musl  | x64, arm64    | Alpine Linux      | Node           |
| Android     | arm64         | NDK API 24/Bionic | Termux Node    |

Node and Electron impose their own OS and library requirements. The glibc baseline is tested with Node in a container; Electron runs on hosted desktop runners. Exact runtime versions and target results are recorded in each [release manifest](https://github.com/sj817/node-pty/releases).

Android ARM64 is tested in a pinned Termux/Bionic Docker image on a native ARM64 runner. It shares the host Linux kernel; device permissions and vendor ROM behavior require device acceptance. Android x64 remains an unpublished build target.

Legacy upstream `v1.1.0` can fail with forced WinPTY in nested Windows console hosts. Default ConPTY passes the hosted CI matrix.

## Electron packaging

Keep `node-pty` or `@qwqo/node-pty` external to bundlers. Unpack the main package and platform dependencies from ASAR, including JS workers, native modules, helpers and DLLs. For electron-builder:

```json
{
  "asarUnpack": [
    "node_modules/node-pty/**/*",
    "node_modules/@qwqo/node-pty/**/*",
    "node_modules/@qwqo/node-pty-*/**/*"
  ]
}
```

This covers both alias and scoped installations. CI tests actual Electron processes from directories and ASAR archives.

## Releases and maintenance

Stable releases use `latest`; upstream prereleases use `next`. Normal versions preserve the upstream version, and Release titles match their Git tags. The manifest records the exact npm version, upstream SHA, build configuration, checksums and runtime results.

- Tags are locked to full SHAs in [upstream-tags.json](upstream-tags.json). The supported upstream range starts at `v1.1.0`; missing or unsuccessful checks keep a release pending.
- Native binaries and upstream JS are built from the same source. Packed packages pass isolated npm/pnpm and target-runtime tests before publication. OIDC publishes platform packages first, then the main package and its dist-tag.
- [Sync](https://github.com/sj817/node-pty/actions/workflows/detect.yml) is scheduled every 15 minutes and runs after builds/publications. Manual runs default to preview; enable `apply` to process the queue. Runtime updates [retest published binaries](https://github.com/sj817/node-pty/actions/workflows/compatibility.yml).

[Build](https://github.com/sj817/node-pty/actions/workflows/build.yml) and [publish](https://github.com/sj817/node-pty/actions/workflows/publish.yml) are separate workflows. Failed publications resume their original immutable bundle. Moved tags, conflicting npm versions and incomplete verification stop publication.

Configuration lives in [release.json](release.json). For a deliberate rebuild, add the source tag to `sync.rebuildTags` and remove it after completion. Trusted Publishing binds each package to `sj817/node-pty` / `publish.yml` / environment `npm`; use local `npt` to inspect changes before provisioning bindings.

## Development

```sh
npm ci --ignore-scripts
npm run lint
npm run format:check
npm run typecheck
npm test
npm run build:native
npm run build:js
npm run verify
```

Repository scripts and loaders use TypeScript and ESM, with ESLint and Prettier.

## License

MIT. See [LICENSE](LICENSE) and [third-party notices](licenses/). Upstream and third-party licenses are retained in the published packages.
