# @qwqo/node-pty

A personal build and distribution project for microsoft/node-pty. The upstream PTY implementation and public API are retained. Packages are built from a pinned commit and distributed through exact-version optional platform dependencies.

## Installation

```sh
npm install @qwqo/node-pty
pnpm add @qwqo/node-pty
```

Check the registry's `latest` tag before installing during the initial rollout. npm assigns `latest` to the first `0.0.1` bootstrap placeholder even when it is published under `bootstrap`; the registry rejects removing `latest`. The placeholder contains no PTY implementation and must not be treated as a usable release. A verified release replaces `latest` only after all platform packages are available.

```js
const pty = require('@qwqo/node-pty');
const terminal = pty.spawn(process.platform === 'win32' ? 'cmd.exe' : '/bin/sh', [], {
  cols: 80,
  rows: 24,
  env: process.env
});
terminal.onData(data => process.stdout.write(data));
terminal.onExit(({ exitCode }) => console.log(exitCode));
terminal.write('echo hello\r');
terminal.resize(100, 40);
```

Installation works with scripts disabled. Keep optional dependencies enabled. The source adapters, loader, build and release tools are TypeScript; the main npm package contains compiled CommonJS and type declarations because Node and Electron execute JavaScript. Native packages contain the native modules and their required helpers. Runtime errors identify the expected package, version, architecture and libc.

## Compatibility

The configured release matrix below becomes supported only after every build and tarball verification job succeeds. Consult the published release's `release-manifest.json` for the exact executed runtime versions and results. Until a release exists, these are validation targets.

| Platform package suffix | Build and test host | Minimum target |
| --- | --- | --- |
| win32-x64 | windows-2022 | Windows 10 22H2 |
| win32-arm64 | windows-11-arm | Windows 11 |
| darwin-x64 | macos-15-intel | macOS 13 |
| darwin-arm64 | macos-14 | macOS 13 |
| linux-x64-glibc | ubuntu-22.04 | glibc 2.35 |
| linux-arm64-glibc | ubuntu-22.04-arm | glibc 2.35 |

Every suffix is prefixed with `@qwqo/node-pty-`. Linux packages declare `libc: ["glibc"]`. musl and Android currently have no published support because target runtime validation is pending. Minimum targets are build baselines. The hosted test OS is listed separately and does not establish acceptance on every older OS.

The initial runtime matrix is Node 22.23.4, 24.22.1 and 26.13.0, plus Electron 43.8.6, 44.10.1 and 45.2.1. Node >=22.14.0 and Node-API >=8 are required by this distribution. Only the listed runtime versions have scheduled acceptance tests.

The pinned source registers each native module with `NODE_API_MODULE` and uses Node-API thread-safe functions. Native sources have no direct V8 or libuv calls. Builds explicitly define `NAPI_VERSION=8`. One binary per OS, architecture and libc is tested across all listed runtimes. Node-API compatibility covers the native interface while PTY behavior, JS runtime APIs, workers and OS libraries are verified separately.

## Electron

Use the package from Electron's main process. Configure the packager to unpack the complete main and platform packages, including JS worker/fork agents, `.node` files, helper executables and DLLs. For electron-builder use

```json
{
  "asarUnpack": [
    "node_modules/@qwqo/node-pty/**/*",
    "node_modules/@qwqo/node-pty-*/**/*"
  ]
}
```

Keep the package external to JS bundlers so worker and forked agent paths remain intact. CI launches actual Electron main processes both from a directory and from `app.asar` with complete packages unpacked. It verifies shell I/O, resize, exit events, exit codes, forced termination, bundled ConPTY and WinPTY on Windows. macOS helpers retain executable permissions inside npm tarballs.

## Upstream and versions

`release.json` is the configuration source. The initial upstream is `v1.1.0`, commit `1def5774632305246fe21f0f69e23a664d6c5910`. Formal builds fetch this full SHA. Each package records upstream identity, build configuration and a build fingerprint. Platform packages record SHA-256 checksums for every native file. Release manifests record SHA-256 and npm SHA-512 integrity for every tarball.

Upstream `M.m.p` maps to downstream `M.m.(p * 1000 + revision)`, with revisions 0 through 999. Thus upstream 1.1.0 revisions 0 and 1 become 1.1.0 and 1.1.1, while upstream 1.1.1 revision 0 becomes 1.1.1000. Prereleases preserve the upstream prerelease identifiers and append `.r<revision>`. Stable releases use `latest`, prereleases use `next`. Every main/platform package has the same exact version.

To update, review the detected tag and native/JS adapters, set the full tag SHA and upstream version in `release.json`, reset revision to zero, and run the build workflow. Increment revision for a loader correction, platform addition or rebuild. Runtime-only changes can retest existing published tarballs without publishing new binaries.

## Workflows

- `detect.yml` runs daily and on demand. It checks the pinned tag for movement, discovers stable and prerelease tags separately, evaluates the configured upstream checks at each exact SHA, and records missing/failing/pending checks in its artifact and job summary. Newly discovered source versions require review and an explicit lock update. Supported Node release lines and Electron's latest three stable lines are discovered from their official feeds. Runtime changes dispatch a deduplicated compatibility-only run after the first release.
- `build.yml` runs policy tests and the upstream gate, builds on six native hosts, tests the packed tarballs in isolated npm and pnpm projects, checks types, runs Node and real Electron, and assembles a release bundle only when every required result passes.
- `publish.yml` takes a successful main-branch build run ID. Its default is a dry run. A real run seals immutable tarballs in a draft GitHub release, verifies the source gate again, publishes and retrieves every platform tarball, publishes the main package, then updates platform tags and the main tag last. Existing versions must match their expected integrity and build fingerprint. Rerun with the same build run ID after partial failure. A rebuilt conflicting tarball requires a new revision.
- `compatibility.yml` retrieves existing release assets and reruns acceptance against a supplied exact runtime matrix. It has read-only repository permissions.

The upstream `ci.yml` only runs on pull requests at the pinned tag. Release gates therefore use the actual Azure Pipelines `node-pty (publish)` and `node-pty (native prebuilds)` checks, including each platform build and the Linux test check. The unrelated Dependabot update checks are excluded. Missing upstream status contexts are not treated as proof of success. Required named checks must independently succeed at the exact source SHA.

## Local development and first publishing

```sh
npm ci --ignore-scripts
npm run typecheck
npm test
npm run gate
npm run build
npm run verify
npm run trust:prepare
```

Builds need the upstream compiler prerequisites, Python and the platform SDK. Verification downloads the configured real Node and Electron runtimes. Linux also needs Xvfb and Electron system libraries. Build and verification use fresh `.work` staging directories. Remove only the relevant generated staging directory before a local retry.

Use `npt` 0.4.2 or newer to inspect `.work/trust`, with `--workflow publish.yml --environment npm --allow-dist-tag`. Run `scan` and `sync --placeholder --placeholder-tag bootstrap --dry-run` first. After confirming all package targets, execute `sync --placeholder --placeholder-tag bootstrap --allow-dist-tag`. npm's unavoidable first-publish `latest` points to the placeholder until the verified release is promoted; do not advertise it as usable. npm login and account 2FA are performed interactively by the maintainer.

Every package must trust `sj817/node-pty`, workflow `publish.yml`, environment `npm`. Direct publishing and dist-tag management are required. The workflow uses GitHub-hosted runners, Node 24.22.1, npm 12.2.1, a public repository and `id-token: write` only in the publishing job. Registry credentials are kept outside the repository. The registry's provenance attestations are checked before promotion.

## License and sources

Upstream's complete MIT license is retained in `LICENSE`. Package licenses include WinPTY, node-addon-api and ConPTY. ConPTY's MIT license is sourced from microsoft/terminal commit `188822fa51dba7e11b64801483f4909db5fd020a`. The bundled ConPTY binaries come from the pinned node-pty source tree. All distribution modifications are MIT licensed.

- [Upstream source](https://github.com/microsoft/node-pty/tree/1def5774632305246fe21f0f69e23a664d6c5910)
- [npt](https://github.com/sj817/npm-trust)
- [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/)
- [Node-API stability](https://nodejs.org/api/n-api.html#implications-of-abi-stability)
