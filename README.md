# @qwqo/node-pty

Cross-platform prebuilt distribution of [microsoft/node-pty](https://github.com/microsoft/node-pty), maintained as a personal project. The PTY implementation and declarations come from a full upstream commit SHA.

## Installation

Upstream stable releases use npm `latest`. Upstream prereleases, including beta tags, use npm `next`.

```sh
npm install @qwqo/node-pty
pnpm add @qwqo/node-pty

# Upstream beta releases
npm install @qwqo/node-pty@next
```

The early `0.0.x` versions are historical test builds. npm permanently reserves previously published name/version combinations, including withdrawn versions.

```ts
import * as pty from "@qwqo/node-pty";

const shell =
  process.platform === "win32"
    ? "cmd.exe"
    : process.env.SHELL ||
      (process.platform === "android" ? "/system/bin/sh" : "/bin/sh");
const terminal = pty.spawn(shell, [], {
  cols: 80,
  rows: 24,
  env: process.env,
});
terminal.onData((data) => process.stdout.write(data));
terminal.onExit(({ exitCode }) => console.log(exitCode));
terminal.write("echo hello\r");
terminal.resize(100, 40);
```

The main tarball contains the upstream JS implementation, public types and platform loader. Each optional platform dependency uses the exact same version. Installation supports disabled scripts and requires optional dependencies. The package contains no implicit node-gyp install input.

## Build and release sequence

1. Select a tag from `upstream-tags.json` and verify its full SHA and CI state.
2. Build platform native modules and required helpers.
3. Compile the upstream TypeScript implementation into ESM JS once, including workers and fork agents. Build the ESM loader and copy the upstream declarations.
4. Test packed tarballs through npm and pnpm in isolated projects. Run actual Node and supported Electron runtimes.
5. Validate Android ARM64 tarballs in the pinned Termux/Bionic container on a native ARM64 runner.
6. Publish platform packages, retrieve and verify their attested tarballs, then publish the main package and promote its stable or prerelease channel.

The publisher checks out the successful build's original repository commit and verifies its source identity, version mapping and tarball checksums. Registry conflicts, moved source tags and incomplete target verification stop publication. Failed uploads can be retried from the original publication run using the same immutable bundle.

Publication runs use an immutable `ci/<build-commit>` Git ref. npm provenance therefore identifies the same commit that built the tarballs, including when newer tags arrive while an older candidate is still running.

Finish in-flight publications before changing workflow files. GitHub checks workflow-file permissions when creating releases for commits whose workflows differ from the default branch; see the [release API requirements](https://docs.github.com/en/rest/releases/releases#create-a-release).

GitHub releases are titled `node-pty`. Assets use names such as `node-pty.tgz`, `node-pty-darwin-arm64.tgz`, `node-pty-linux-x64-musl.tgz` and `node-pty-android-arm64.tgz`. Version information lives in package metadata, the Git tag and `release-manifest.json`. npm controls its own registry download URLs.

## Version mapping

Each upstream stable patch reserves 1,000 downstream revisions. For upstream `M.m.p` and revision `r`, the npm version is `M.m.(p * 1000 + r)`, with `r` from 0 through 999. Prereleases retain their identifiers and append `.qwqo.r` after the encoded patch. This preserves SemVer ordering across upstream patches, beta sequences and downstream rebuilds.

| Upstream        | Revision | npm version            | Channel  |
| --------------- | -------- | ---------------------- | -------- |
| `1.1.0`         | 1        | `1.1.1`                | `latest` |
| `1.1.1`         | 0        | `1.1.1000`             | `latest` |
| `1.2.0-beta.17` | 0        | `1.2.0-beta.17.qwqo.0` | `next`   |
| `1.2.0-beta.17` | 1        | `1.2.0-beta.17.qwqo.1` | `next`   |

The initial `1.1.0` npm version was withdrawn and remains reserved, so its first production backfill starts at revision 1. `SOURCE.json`, `nodePty.upstream` and the release manifest identify the exact upstream version, SHA and downstream revision. Backfilling an older version retains a newer channel target.

## Platform validation

These are configured targets. Each release manifest records which runtimes actually executed and the checksums of the exact tarballs.

| Platform suffix   | Build baseline                | Runtime verification                         |
| ----------------- | ----------------------------- | -------------------------------------------- |
| win32-x64         | Windows Server 2022 toolchain | Node and Electron on Windows x64             |
| win32-arm64       | Windows 11 ARM64, VS 2026     | Node and Electron on Windows ARM64           |
| darwin-x64        | macOS deployment target 13    | Node and Electron on macOS Intel             |
| darwin-arm64      | macOS deployment target 13    | Node and Electron on macOS ARM64             |
| linux-x64-glibc   | manylinux glibc 2.28          | Baseline container, Node and Electron        |
| linux-arm64-glibc | manylinux glibc 2.28          | Baseline container, Node and Electron        |
| linux-x64-musl    | Pinned Alpine Node image      | Node 22, 24 and 26 container images          |
| linux-arm64-musl  | Pinned Alpine Node image      | Node 22, 24 and 26 container images          |
| android-arm64     | Android NDK API 24            | Termux/Bionic container Node, npm and pnpm   |
| android-x64       | Android NDK API 24            | Build artifact pending a target runtime test |

Every published suffix is prefixed with `@qwqo/node-pty-`. Linux manifests specify `libc`. Android x64 stays outside the npm release set until target verification exists. Electron binaries are validated on its desktop platforms. Android and native musl currently use Node-only verification.

The current adapter uses Node-API 8 and Node 22.14+ synchronous ESM loading. The addon is built for the baselines above. Node and Electron also impose their own OS and library requirements. Electron runs on the configured hosted desktop runners; the glibc 2.28 container verifies addon loading with Node. Container image digests and configuration are pinned in `release.json`. C++ runtime libraries are linked statically on Linux to avoid importing a newer host libstdc++ requirement.

Node and Electron share one binary for a supported OS, architecture and libc when the selected source uses Node-API. Each combination is still tested with actual runtime versions. Older upstream sources using NAN/V8 require separate ABI adapters.

## Electron and ESM

Repository scripts, tests, loaders and generated JS use ESM. Native `.node` loading uses Node's `createRequire`. Node 22.14+ callers can also load the synchronous ESM public API with `require()`.

Default imports, named imports and synchronous `require()` expose the upstream API.

Keep the package external to bundlers and unpack the complete main and platform packages from ASAR, including worker JS, `.node` modules, helpers and DLLs. An electron-builder configuration is

```json
{
  "asarUnpack": [
    "node_modules/@qwqo/node-pty/**/*",
    "node_modules/@qwqo/node-pty-*/**/*"
  ]
}
```

CI runs real Electron main processes from both a directory and ASAR. macOS `spawn-helper` retains executable permissions. Windows packages include ConPTY and OpenConsole, plus WinPTY when the selected upstream tag still builds it.

With upstream `v1.1.0`, an additional local nested pseudo-console test could not start forced WinPTY (`useConpty: false`). Default ConPTY passed the PTY and descendant cleanup checks, while the upstream console-list helper logged `AttachConsole failed` during shutdown. These terminal-host limitations are separate from the passing hosted Windows CI matrix.

## Historical tags and CI

`upstream-tags.json` locks all discovered tags to SHAs and records their native-interface family and observed CI profile. The supported backfill floor is `v1.1.0`. It includes every existing `1.2.0-beta.*` tag. Earlier `1.1.0-beta*` and legacy Node/V8 releases are outside this range.

Detection compares the complete tag set every 15 minutes and after builds/publications complete. New tags are pinned before dispatch. Each selected tag gets its own source diff, recipe fingerprint, revision and build. Diff bases follow the stable line or the same prerelease series. Native, runtime JS, types, build configuration and CI changes are recorded separately in the plan artifact.

The queue runs at most two candidate builds at once. Successful matching recipes are reused. Published source versions keep their verified recipe when adapters for other tags change. To rebuild an existing source version, list its tag in `sync.rebuildTags`; a changed recipe allocates the next downstream revision. Remove the tag after the rebuild. A supported runtime update retests published stable and beta tarballs. Failed builds and partial publications retain their original run IDs for retry. Out-of-order completions publish historical versions while preserving the highest verified stable and beta channel targets.

The `beta.4` and `beta.5` Linux/Android builds backport upstream commit `ac22bd8937fc3671687093123fce2a3104c4af7a`'s missing-constant guard for older libc headers. The adapter accepts only their exact source SHAs and records the source file's before/after hashes in each affected platform package.

- `test.yml` runs ESLint, Prettier, TypeScript and policy tests.
- `build.yml` builds native assets, compiles the main package and verifies desktop, musl and Android targets before assembling a bundle.
- `android.yml` runs packed Android assets under the pinned official Termux Docker image on a GitHub-hosted ARM64 runner. Image digest, Node packages and library checksums are fixed in `release.json`.
- `publish.yml` accepts a successful build run ID, defaults to dry-run, validates the bundle, and publishes its channel through OIDC.
- `compatibility.yml` retests published tarballs without publishing new binaries.
- `detect.yml` tracks tags and runtime lines, reports the queue, and dispatches builds and verified publications. Manual runs default to preview mode. Enable `apply` to process the queue.

The upstream gate uses exact-SHA Azure Pipelines checks observed from the source's `publish.yml` and native prebuild matrix. Unknown CI layouts, missing or cancelled checks, and unsupported native API families retain explicit pending reasons. The initial `beta.1` native checks and `beta.15` cancelled publish check remain pending.

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

Use `npm run format` to apply Prettier. ESLint uses the official recommended JS and typescript-eslint configurations with eslint-config-prettier. Source adapters fail when the expected upstream structure changes.

`android.yml` can retest an existing build run or published release. Its proof identifies the actual Android Node process and Bionic container environment. The container shares the host Linux kernel. Phone permissions and vendor ROM behavior remain part of device acceptance.

For additional device acceptance, download the exact `javascript` and `native-android-arm64` artifacts into `dist/main` and `dist/android-arm64`. Set `ADB_SERIAL` and `ANDROID_NODE_PREFIX`, then run `node scripts/android-test.ts`. This root-ADB harness records the device API level separately from container proofs.

Trusted Publishing bindings use `sj817/node-pty`, `publish.yml`, environment `npm`. Use local `npt` with `--allow-dist-tag`, inspect a dry-run and confirm new package targets before provisioning. CI uses GitHub OIDC with no stored npm token.

## License

The complete upstream MIT license and third-party licenses for WinPTY, node-addon-api and ConPTY are retained. The initial reviewed source is microsoft/node-pty `v1.1.0` at `1def5774632305246fe21f0f69e23a664d6c5910`. ConPTY licensing is sourced from microsoft/terminal commit `188822fa51dba7e11b64801483f4909db5fd020a`. Distribution modifications are MIT licensed.

Static C++ runtime notices are included for Linux and Android. The notices are sourced from GCC releases/gcc-14.3.0 and LLVM llvmorg-18.1.8. Native builds record shared-library dependencies and reject an unexpected dynamic C++ runtime or glibc symbols above the configured baseline.
