import { pathToFileURL } from "node:url";
import { join } from "node:path";
import semver from "semver";
import { config, root, run, writeJson } from "./common.ts";

export function classifyNativeSource(
  source: string,
): "node-api" | "node-v8" | "unknown" {
  if (
    /\b(?:Nan::|NAN_MODULE_INIT|v8::|NODE_MODULE\s*\(|using namespace v8)/.test(
      source,
    )
  )
    return "node-v8";
  if (
    /\b(?:NODE_API_MODULE|NAPI_MODULE)\s*\(/.test(source) &&
    source.includes("<napi.h>")
  )
    return "node-api";
  return "unknown";
}

async function main() {
  const pages = JSON.parse(
    run(
      "gh",
      [
        "api",
        `repos/${config.upstream.repository}/tags?per_page=100`,
        "--paginate",
        "--slurp",
      ],
      { capture: true },
    ),
  );
  const tags = pages.flat().filter((tag) => semver.valid(tag.name));
  const records = [];
  for (let index = 0; index < tags.length; index += 4) {
    const batch = await Promise.all(
      tags.slice(index, index + 4).map(async (tag) => {
        let api: "node-api" | "node-v8" | "unknown" = "unknown";
        let sourcePath;
        for (const candidate of [
          "src/unix/pty.cc",
          "src/pty.cc",
          "src/ppty.cc",
        ]) {
          const url = `https://raw.githubusercontent.com/${config.upstream.repository}/${tag.commit.sha}/${candidate}`;
          const response = await fetch(url, {
            signal: AbortSignal.timeout(45000),
          });
          if (!response.ok) continue;
          api = classifyNativeSource(await response.text());
          sourcePath = candidate;
          break;
        }
        return {
          tag: tag.name,
          sha: tag.commit.sha,
          version: semver.valid(tag.name),
          api,
          sourcePath,
        };
      }),
    );
    records.push(...batch);
  }
  records.sort((a, b) => semver.rcompare(a.version, b.version));
  writeJson(join(root, "upstream-tags.json"), records);
  console.log(
    JSON.stringify({
      tags: records.length,
      nodeApi: records.filter((tag) => tag.api === "node-api").length,
      nodeV8: records.filter((tag) => tag.api === "node-v8").length,
      unknown: records.filter((tag) => tag.api === "unknown").length,
    }),
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();
