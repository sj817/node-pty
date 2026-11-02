# @qwqo/node-pty

Experimental prebuilt distribution of [microsoft/node-pty](https://github.com/microsoft/node-pty), maintained as a personal project. The PTY implementation and declarations come from a full upstream commit SHA.

## Test releases

Development uses versions `0.0.1` through `0.0.100` and the npm `next` tag. The first occupied version, `0.0.1`, is a binding placeholder. The withdrawn `1.1.0` release is unavailable. Testing started with `0.0.2`. The next candidate is selected in `release.json`.

```sh
npm install @qwqo/node-pty@next
pnpm add @qwqo/node-pty@next
```

Use these commands once the corresponding test workflow has published `next`. The initial `latest` tag may still point at the empty bootstrap package. npm permanently reserves previously published name/version combinations, including withdrawn versions.

```ts
import * as pty from "@qwqo/node-pty";

const shell = process.platform === "win32" ? "cmd.exe" : "/bin/sh";
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
5. Validate Android ARM64 tarballs on a device and supply the resulting proof to the publishing workflow.
6. Publish platform packages, retrieve and verify their attested tarballs, then publish the main package and promote `next`.

The publisher rejects versions outside the test range and any target tag other than `next`. It requires a successful build from the same repository commit as the publication workflow. Registry conflicts, moved source tags and incomplete target verification stop publication. Failed uploads can be retried using the same build run and Android proof.

GitHub test releases are prereleases titled `node-pty`. Assets use names such as `node-pty.tgz`, `node-pty-darwin-arm64.tgz`, `node-pty-linux-x64-musl.tgz` and `node-pty-android-arm64.tgz`. Version information lives in package metadata, the Git tag and `release-manifest.json`. npm controls its own registry download URLs.

## Platform validation

These are configured test targets. A test release's manifest records which runtimes actually executed and the checksums of the exact tarballs.

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
| android-arm64     | Android NDK API 24            | Android/Bionic device Node, npm and pnpm     |
| android-x64       | Android NDK API 24            | Build artifact pending a target runtime test |

Every published suffix is prefixed with `@qwqo/node-pty-`. Linux manifests specify `libc`. Android x64 stays outside the npm release set until target verification exists. Electron binaries are validated on its desktop platforms. Android and native musl currently use Node-only verification.

The current adapter uses Node-API 8 and Node 22.14+ synchronous ESM loading. Node's own OS and libc requirements also apply. Lowering the addon's glibc baseline cannot lower the Node executable's requirements. Container image digests and configuration are pinned in `release.json`. C++ runtime libraries are linked statically on Linux to avoid importing a newer host libstdc++ requirement.

Node and Electron share one binary for a supported OS, architecture and libc when the selected source uses Node-API. Each combination is still tested with actual runtime versions. Older upstream sources using NAN/V8 require separate ABI adapters.

Windows upstream console-list agents can emit `AttachConsole failed` during shell-exit races. Tests check shell output, resizing, exit events, exit status and process cleanup separately.

## Electron and ESM

Repository scripts, tests, loaders and generated JS use ESM. Native `.node` loading uses Node's `createRequire`. Node 22.14+ callers can also load the synchronous ESM public API with `require()`.

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

## Historical tags and CI

`upstream-tags.json` locks every discovered historical tag to a SHA and records its native-interface family. `detect.yml` checks all tags, reports exact-SHA CI failures or missing evidence, and detects moved tags. Node-API tags can be selected individually through `build.yml` inputs. A successful compilation becomes publishable only after all runtime tests and the upstream gate pass. Historical NAN/V8 or unclassified tags remain pending a reviewed ABI/build adapter.

- `test.yml` runs ESLint, Prettier, TypeScript and policy tests.
- `build.yml` builds native assets, compiles the complete main package, verifies desktop/musl targets and uploads a candidate bundle. Android device verification is a separate publication gate.
- `publish.yml` accepts a candidate build run ID and Android proof, defaults to dry-run, and publishes only test versions to `next` through OIDC.
- `compatibility.yml` retests published tarballs without publishing new binaries.
- `detect.yml` tracks upstream tags and supported runtime lines daily and on demand.

The present upstream gate uses observed Azure Pipelines checks from `release.json`. Historical tags with different or absent CI retain a pending reason for review. New tag discovery never silently authorizes a formal release.

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

For Android tests, download the exact `javascript` and `native-android-arm64` CI artifacts into `dist/main` and `dist/android-arm64`. Set `ADB_SERIAL` and `ANDROID_NODE_PREFIX` to a connected Android device and its staged Node runtime, then run `node scripts/android-test.ts`. The generated `dist/android-arm64/verified.json` is the `android_proof` workflow input. This path requires root ADB for the current device harness and records Android/Bionic identity and tarball integrity.

Trusted Publishing bindings use `sj817/node-pty`, `publish.yml`, environment `npm`. Use local `npt` with `--allow-dist-tag`, inspect a dry-run and confirm new package targets before provisioning. CI uses GitHub OIDC with no stored npm token.

## License

The complete upstream MIT license and third-party licenses for WinPTY, node-addon-api and ConPTY are retained. The initial reviewed source is microsoft/node-pty `v1.1.0` at `1def5774632305246fe21f0f69e23a664d6c5910`. ConPTY licensing is sourced from microsoft/terminal commit `188822fa51dba7e11b64801483f4909db5fd020a`. Distribution modifications are MIT licensed.

Static C++ runtime notices are included for Linux and Android. The notices are sourced from GCC releases/gcc-14.3.0 and LLVM llvmorg-18.1.8. Native builds record shared-library dependencies and reject an unexpected dynamic C++ runtime or glibc symbols above the configured baseline.
