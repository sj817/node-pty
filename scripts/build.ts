import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { adaptUpstream, compileEsm } from "./adapt.ts";
import { adaptNativeSource } from "./native-adapter.ts";
import {
  buildKey,
  config,
  currentPlatform,
  files,
  hash,
  integrity,
  packageName,
  publication,
  readJson,
  releasePlatforms,
  recipeKey,
  root,
  run,
  version,
  writeJson,
} from "./common.ts";

const kind = process.argv[2];
if (!["js", "native"].includes(kind))
  throw new Error("Use build:js or build:native");
const platform = kind === "native" ? currentPlatform() : undefined;
const id = platform?.id || "main";
const key = buildKey();
const work = join(root, ".work", version, id);
const source = join(work, "upstream");
const out = join(root, "dist", id);
mkdirSync(work, { recursive: true });
mkdirSync(out, { recursive: true });
if (!existsSync(join(source, ".git"))) {
  run("git", ["init", source]);
  run(
    "git",
    [
      "remote",
      "add",
      "origin",
      `https://github.com/${config.upstream.repository}.git`,
    ],
    { cwd: source },
  );
}
run("git", ["fetch", "--depth=1", "origin", config.upstream.sha], {
  cwd: source,
});
run("git", ["checkout", "--detach", config.upstream.sha], { cwd: source });
if (
  run("git", ["rev-parse", "HEAD"], { cwd: source, capture: true }) !==
  config.upstream.sha
)
  throw new Error("Source SHA mismatch");
if (
  readJson(join(source, "package.json")).version !==
  config.upstream.sourceVersion
)
  throw new Error("Source version mismatch");
run(
  "git",
  [
    "restore",
    "--source=HEAD",
    "--",
    "binding.gyp",
    "package-lock.json",
    "src/tsconfig.json",
    "src/unix/pty.cc",
  ],
  { cwd: source },
);

const nativePatches = [];
if (kind === "native") {
  const path = join(source, "src/unix/pty.cc");
  const adapted = adaptNativeSource(
    readFileSync(path, "utf8"),
    config.upstream.sha,
    platform.os,
  );
  if (adapted.patches.length) writeFileSync(path, adapted.source);
  nativePatches.push(...adapted.patches);
}

const lock = readJson(join(source, "package-lock.json"));
// The pinned upstream lock omitted chokidar's optional macOS dependency.
if (!lock.packages["node_modules/fsevents"]) {
  lock.packages["node_modules/fsevents"] = {
    version: "2.3.3",
    resolved: "https://registry.npmjs.org/fsevents/-/fsevents-2.3.3.tgz",
    integrity:
      "sha512-5xoDfX+fL7faATnagmWPpbFtwh/R77WmMMqqHGS65C3vvB0YHrgF+B1YmZ3441tMj5n63k0212XNoJwzlhffQw==",
    dev: true,
    optional: true,
    hasInstallScript: true,
    os: ["darwin"],
    engines: { node: "^8.16.0 || ^10.6.0 || >=11.0.0" },
  };
}
writeJson(join(source, "package-lock.json"), lock);
run("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], {
  cwd: source,
});

const features = {
  winpty: readFileSync(join(source, "binding.gyp"), "utf8").includes(
    "winpty.gyp",
  ),
};
const metadata = {
  upstream: config.upstream,
  release: publication,
  recipeKey: recipeKey(),
  napi: config.napi,
  buildKey: key,
  features,
  nativePatches,
};
const base = {
  version,
  description: "Cross-platform prebuilt distribution of microsoft/node-pty",
  license: "MIT",
  repository: {
    type: "git",
    url: `git+https://github.com/${config.repository}.git`,
  },
  homepage: `https://github.com/${config.repository}#readme`,
  publishConfig: { access: "public", tag: publication.channel },
  engines: { node: ">=22.14.0" },
};
const stage = join(work, "package");
if (existsSync(stage))
  throw new Error(
    `Staging directory exists: ${stage}. Use a fresh build workspace.`,
  );
mkdirSync(stage, { recursive: true });
cpSync(join(root, "LICENSE"), join(stage, "LICENSE"));
mkdirSync(join(stage, "licenses"), { recursive: true });
const notices =
  kind === "js"
    ? files(join(root, "licenses"))
    : platform.os === "win32"
      ? ["conpty.txt", ...(features.winpty ? ["winpty.txt"] : [])]
      : platform.os === "linux"
        ? ["gcc-gpl3.txt", "gcc-runtime-exception.txt"]
        : platform.os === "android"
          ? ["libcxx.txt", "libcxxabi.txt", "libunwind.txt", "compiler-rt.txt"]
          : [];
for (const notice of notices)
  cpSync(join(root, "licenses", notice), join(stage, "licenses", notice));
cpSync(
  join(source, "node_modules/node-addon-api/LICENSE.md"),
  join(stage, "licenses/node-addon-api.md"),
);

if (kind === "js") {
  const upstreamConfig = readJson(join(source, "src/tsconfig.json"));
  upstreamConfig.compilerOptions.typeRoots = ["../node_modules/@types"];
  upstreamConfig.compilerOptions.newLine = "lf";
  writeJson(join(source, "src/tsconfig.json"), upstreamConfig);
  run("npm", ["run", "build"], { cwd: source });
  for (const filename of files(join(source, "src"))) {
    if (
      !filename.endsWith(".ts") ||
      filename.endsWith(".test.ts") ||
      filename.endsWith(".d.ts") ||
      filename.startsWith("test/")
    )
      continue;
    const target = join(stage, "lib", filename.replace(/\.ts$/, ".js"));
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(
      target,
      adaptUpstream(
        readFileSync(join(source, "src", filename), "utf8"),
        filename,
      ),
    );
  }
  for (const [input, output] of [
    ["runtime/loader.ts", "loader.js"],
    ["runtime/entry.ts", "index.js"],
  ]) {
    writeFileSync(
      join(stage, output),
      compileEsm(readFileSync(join(root, input), "utf8"), input),
    );
  }
  const declaration = readFileSync(
    join(source, "typings/node-pty.d.ts"),
    "utf8",
  ).replace(/\r\n/g, "\n");
  if (!declaration.includes("declare module 'node-pty'"))
    throw new Error("Unreviewed upstream type declarations");
  writeFileSync(
    join(stage, "index.d.ts"),
    declaration.replace(
      "declare module 'node-pty'",
      `declare module '${config.package}/upstream-types'`,
    ) +
      `\ndeclare module '${config.package}' {\n  export * from '${config.package}/upstream-types';\n  import * as pty from '${config.package}/upstream-types';\n  export default pty;\n}\n`,
  );
  cpSync(join(root, "README.md"), join(stage, "README.md"));
  writeJson(join(stage, "package.json"), {
    ...base,
    name: config.package,
    type: "module",
    main: "./index.js",
    types: "./index.d.ts",
    exports: {
      ".": { types: "./index.d.ts", default: "./index.js" },
      "./package.json": "./package.json",
    },
    files: [
      "lib",
      "index.js",
      "index.d.ts",
      "loader.js",
      "licenses",
      "SOURCE.json",
    ],
    optionalDependencies: Object.fromEntries(
      releasePlatforms.map((p) => [packageName(p), version]),
    ),
    nodePty: metadata,
  });
  writeJson(join(stage, "SOURCE.json"), {
    ...metadata,
    buildNode: config.buildNode,
    modifications: [
      "ESM module syntax and explicit relative extensions",
      "Node-API optional platform loader",
      "ASAR helper paths",
      "Renamed ambient module declaration",
    ],
  });
} else {
  let androidNdk;
  let binding = readFileSync(join(source, "binding.gyp"), "utf8");
  if (!binding.includes("'target_defaults': {"))
    throw new Error("Unreviewed upstream binding.gyp");
  const staticRuntime =
    platform.os === "linux"
      ? "'ldflags': ['-static-libstdc++', '-static-libgcc'],"
      : "";
  binding = binding.replace(
    "'target_defaults': {",
    `'target_defaults': {\n'defines': ['NAPI_VERSION=${config.napi}'],${staticRuntime}`,
  );
  if (platform.os === "darwin")
    binding = binding.replace(
      '"MACOSX_DEPLOYMENT_TARGET":"10.7"',
      `"MACOSX_DEPLOYMENT_TARGET":"${platform.deploymentTarget}"`,
    );
  writeFileSync(join(source, "binding.gyp"), binding);
  const env = {
    ...process.env,
    npm_config_arch: platform.cpu,
    ...(platform.deploymentTarget
      ? { MACOSX_DEPLOYMENT_TARGET: platform.deploymentTarget }
      : {}),
  };
  const nodeGyp = join(root, "node_modules/node-gyp/bin/node-gyp.js");
  if (platform.os === "android") {
    const ndk = process.env.ANDROID_NDK_HOME;
    if (!ndk)
      throw new Error(
        "ANDROID_NDK_HOME is required for Android cross compilation",
      );
    androidNdk = readFileSync(join(ndk, "source.properties"), "utf8")
      .match(/^Pkg.Revision\s*=\s*(.+)$/m)?.[1]
      .trim();
    if (androidNdk !== platform.ndkVersion)
      throw new Error("Android NDK differs from the pinned toolchain");
    const headers = join(work, "headers");
    run(
      process.execPath,
      [
        nodeGyp,
        "install",
        `--target=${config.buildNode}`,
        `--devdir=${headers}`,
      ],
      { cwd: source },
    );
    const triple =
      platform.cpu === "arm64"
        ? "aarch64-linux-android"
        : "x86_64-linux-android";
    const compiler = join(
      ndk,
      "toolchains/llvm/prebuilt/linux-x86_64/bin",
      `${triple}${platform.androidApi}-clang++`,
    );
    mkdirSync(join(source, "build/Release"), { recursive: true });
    run(
      compiler,
      [
        "-shared",
        "-fPIC",
        "-O2",
        "-std=c++17",
        "-fexceptions",
        "-DNAPI_VERSION=8",
        "-DNAPI_CPP_EXCEPTIONS",
        "-static-libstdc++",
        "-I",
        join(headers, config.buildNode, "include/node"),
        "-I",
        join(source, "node_modules/node-addon-api"),
        "src/unix/pty.cc",
        "-o",
        "build/Release/pty.node",
      ],
      { cwd: source },
    );
  } else {
    run(
      process.execPath,
      [
        nodeGyp,
        "rebuild",
        `--target=${config.buildNode}`,
        `--arch=${platform.cpu}`,
      ],
      { cwd: source, env },
    );
    run(process.execPath, ["scripts/post-install.js"], { cwd: source, env });
  }
  const binaries =
    platform.os === "win32"
      ? [
          "conpty.node",
          "conpty_console_list.node",
          "conpty/conpty.dll",
          "conpty/OpenConsole.exe",
        ]
      : platform.os === "darwin"
        ? ["pty.node", "spawn-helper"]
        : ["pty.node"];
  if (platform.os === "win32" && features.winpty)
    binaries.push("pty.node", "winpty-agent.exe", "winpty.dll");
  for (const filename of binaries) {
    const target = join(stage, "bin", filename);
    mkdirSync(join(target, ".."), { recursive: true });
    cpSync(join(source, "build/Release", filename), target);
    if (filename === "spawn-helper") chmodSync(target, 0o755);
  }
  writeJson(join(stage, "package.json"), {
    ...base,
    name: packageName(platform),
    os: [platform.os],
    cpu: [platform.cpu],
    ...(platform.libc ? { libc: [platform.libc] } : {}),
    files: ["bin", "licenses", "SOURCE.json"],
    nodePty: { ...metadata, platform: platform.id, glibc: platform.glibc },
  });
  writeFileSync(
    join(stage, "README.md"),
    `# ${packageName(platform)}\n\nNative assets for ${config.package}. Target ${platform.minimumOS}. See SOURCE.json for the fixed upstream and build configuration.\n`,
  );
  let abiRequirements;
  if (platform.os === "linux" || platform.os === "android") {
    const binary = join(stage, "bin/pty.node");
    const dynamic = run("readelf", ["-d", binary], { capture: true });
    const libraries = [...dynamic.matchAll(/\(NEEDED\).*\[([^\]]+)\]/g)].map(
      (match) => match[1],
    );
    if (
      libraries.some((library) =>
        /libstdc\+\+|libgcc_s|libc\+\+_shared/.test(library),
      )
    )
      throw new Error("C++ runtime must be linked statically");
    const symbols = run("readelf", ["--version-info", binary], {
      capture: true,
    });
    const glibc = [...symbols.matchAll(/GLIBC_(\d+)\.(\d+)/g)]
      .map((match) => [Number(match[1]), Number(match[2])])
      .sort((a, b) => b[0] - a[0] || b[1] - a[1])[0];
    if (glibc && platform.glibc) {
      const minimum = platform.glibc.split(".").map(Number);
      if (
        glibc[0] > minimum[0] ||
        (glibc[0] === minimum[0] && glibc[1] > minimum[1])
      )
        throw new Error("Native symbols exceed the configured glibc baseline");
    }
    abiRequirements = { libraries, glibc: glibc?.join(".") };
  }
  writeJson(join(stage, "SOURCE.json"), {
    ...metadata,
    platform,
    buildNode: config.buildNode,
    compiler:
      platform.os === "android"
        ? `Android NDK ${androidNdk} clang++`
        : process.env.CXX || "node-gyp default",
    buildEnvironment: {
      node: process.versions.node,
      arch: process.arch,
      nodeGyp: readJson(join(root, "node_modules/node-gyp/package.json"))
        .version,
      androidNdk,
      runnerImage: process.env.ImageOS || null,
      runnerImageVersion: process.env.ImageVersion || null,
      container: platform.container || null,
    },
    bindingSha256: hash(binding),
    abiRequirements,
    files: Object.fromEntries(
      binaries.map((filename) => [
        filename,
        hash(readFileSync(join(stage, "bin", filename))),
      ]),
    ),
  });
}

const packed = JSON.parse(
  run(
    "npm",
    ["pack", "--json", "--ignore-scripts", "--pack-destination", out],
    { cwd: stage, capture: true },
  ),
)[0];
if (
  packed.files.some((file) =>
    /(?:\.pdb$|binding\.gyp$|\.cc$|\.map$|\.test\.js$)/.test(file.path),
  )
)
  throw new Error("Unexpected build input in tarball");
if (kind === "js") {
  for (const required of [
    "index.js",
    "loader.js",
    "index.d.ts",
    "lib/index.js",
    "lib/unixTerminal.js",
    "lib/windowsPtyAgent.js",
    "lib/worker/conoutSocketWorker.js",
  ]) {
    if (!packed.files.some((file) => file.path === required))
      throw new Error(`Incomplete main tarball: ${required}`);
  }
}
const filename = kind === "js" ? "node-pty.tgz" : `node-pty-${platform.id}.tgz`;
renameSync(join(out, packed.filename), join(out, filename));
const name = kind === "js" ? config.package : packageName(platform);
const packages = [
  {
    name,
    version,
    filename,
    integrity: integrity(join(out, filename)),
    sha256: hash(readFileSync(join(out, filename))),
  },
];
writeJson(join(out, "build.json"), {
  platform: id,
  buildKey: key,
  upstream: config.upstream,
  version,
  publication,
  recipeKey: recipeKey(),
  packages,
});
console.log(`Built ${id} / ${version} / ${key}`);
