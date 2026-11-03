import { appendFileSync } from "node:fs";
import {
  config,
  releasePlatforms,
  readJson,
  root,
  publication,
  recipeKey,
} from "./common.ts";
import { join } from "node:path";

const source = readJson(join(root, "upstream-tags.json")).find(
  (tag) => tag.sha === config.upstream.sha,
);
if (
  process.env.EXPECTED_RECIPE_KEY &&
  process.env.EXPECTED_RECIPE_KEY !== recipeKey()
)
  throw new Error("Queued build recipe differs from this checkout");
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
appendFileSync(
  process.env.GITHUB_OUTPUT,
  `version=${publication.version}\nrevision=${publication.revision}\nupstream_tag=${config.upstream.tag}\nrecipe_key=${recipeKey()}\n`,
);
