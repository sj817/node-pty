import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { root, readJson, writeJson } from "./common.ts";
import { refreshTags } from "./upstream.ts";
export { classifyNativeSource } from "./upstream.ts";

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const path = join(root, "upstream-tags.json");
  const records = await refreshTags(readJson(path));
  writeJson(path, records);
  console.log(
    JSON.stringify({
      tags: records.length,
      nodeApi: records.filter((tag) => tag.api === "node-api").length,
    }),
  );
}
