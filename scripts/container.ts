import {
  config,
  publication,
  currentPlatform,
  readJson,
  root,
  run,
  writeJson,
  version,
} from "./common.ts";
import { join } from "node:path";

const platform = currentPlatform();
const mode = process.argv[2];
if (!platform.container || !["build", "verify"].includes(mode))
  throw new Error("Expected a configured Linux container and build or verify");

function execute(image: string, command: string, proof: string) {
  const toolNode = mode === "build" ? config.publishNode : config.buildNode;
  const ownership = `trap 'chown -Rh ${process.getuid()}:${process.getgid()} /work/.work /work/dist /work/node_modules' EXIT\n`;
  const setup =
    platform.libc === "musl"
      ? "apk add --no-cache build-base python3 git linux-headers\n"
      : `export PATH=/opt/node-pty-node/bin:/opt/python/cp312-cp312/bin:$PATH
mkdir -p /opt/node-pty-node
curl -fsSL https://nodejs.org/dist/v${toolNode}/node-v${toolNode}-linux-${platform.cpu}.tar.xz -o /tmp/node.tar.xz
curl -fsSL https://nodejs.org/dist/v${toolNode}/SHASUMS256.txt -o /tmp/SHASUMS256.txt
expected=$(awk '$2=="node-v${toolNode}-linux-${platform.cpu}.tar.xz" {print $1}' /tmp/SHASUMS256.txt)
test -n "$expected"
echo "$expected  /tmp/node.tar.xz" | sha256sum -c -
tar -xJf /tmp/node.tar.xz --strip-components=1 -C /opt/node-pty-node
`;
  run("docker", [
    "run",
    "--rm",
    "-v",
    `${root}:/work`,
    "-w",
    "/work",
    "-e",
    `TARGET_PLATFORM=${platform.id}`,
    "-e",
    `UPSTREAM_TAG=${config.upstream.tag}`,
    "-e",
    `TEST_VERSION=${publication.mode === "test" ? version : ""}`,
    "-e",
    `DOWNSTREAM_REVISION=${publication.revision}`,
    "-e",
    `RETEST_VERSION=${mode === "verify" ? process.env.RETEST_VERSION || "" : ""}`,
    "-e",
    `PROOF_NAME=${proof}`,
    "-e",
    "CURRENT_NODE_ONLY=1",
    image,
    "sh",
    "-ec",
    ownership +
      setup +
      "npm ci --ignore-scripts --no-audit --no-fund\n" +
      command,
  ]);
}

if (mode === "build") {
  execute(platform.container, "npm run build:native", "baseline");
} else if (platform.libc === "musl") {
  const proofs = [];
  const images = process.env.RUNTIME_MATRIX
    ? JSON.parse(process.env.RUNTIME_MATRIX).muslImages || config.muslRuntimes
    : config.muslRuntimes;
  for (const [index, image] of images.entries()) {
    const name = `musl-${index}`;
    execute(image, "npm run verify", name);
    proofs.push(readJson(join(root, "dist", platform.id, `${name}.json`)));
  }
  writeJson(join(root, "dist", platform.id, "verified.json"), {
    ...proofs[0],
    runtimes: {
      node: proofs.flatMap((proof) => proof.runtimes.node),
      electron: [],
    },
    results: proofs.flatMap((proof) => proof.results),
    containers: images,
  });
} else {
  execute(platform.container, "npm run verify", "baseline");
}
