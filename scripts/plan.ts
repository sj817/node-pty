import { appendFileSync } from "node:fs";
import { config, releasePlatforms, readJson, root } from "./common.ts";
import { join } from "node:path";

const source = readJson(join(root, "upstream-tags.json")).find(
  (tag) => tag.sha === config.upstream.sha,
);
if (source?.api !== "node-api")
  throw new Error(
    `Historical ${config.upstream.tag} needs a reviewed Node/V8 ABI adapter before building`,
  );

const matrices = {
  native: { include: config.platforms },
  verify: {
    include: releasePlatforms.filter((platform) => platform.os !== "android"),
  },
};
for (const [name, matrix] of Object.entries(matrices)) {
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    `${name}=${JSON.stringify(matrix)}\n`,
  );
}
