import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import semver from "semver";
import {
  config,
  github,
  githubPages,
  jsonRequest,
  readJson,
  recipeKey,
  root,
  run,
  writeJson,
} from "./common.ts";
import { publicationFor, type Publication } from "./version.ts";

type PublishedRecord = {
  version: string;
  nodePty?: {
    release?: Publication;
    upstream: { version: string; sha: string };
    recipeKey: string;
  };
};
type SyncState = {
  state: string;
  reason?: string;
  runId?: number;
  publicationRun?: number;
  url?: string;
};
type SyncCandidate = SyncState & {
  tag: string;
  sha: string;
  version: string;
  recipeKey: string;
  publication: Publication;
};

export function candidatePublication(
  tag,
  versions: Record<string, PublishedRecord>,
  key: string,
) {
  const previous = Object.values(versions)
    .filter(
      (record) =>
        record.nodePty?.release?.mode === "release" &&
        record.nodePty.upstream.version === tag.version,
    )
    .sort((a, b) => b.nodePty.release.revision - a.nodePty.release.revision);
  if (previous.some((record) => record.nodePty.upstream.sha !== tag.sha))
    throw new Error(`Conflicting upstream SHA for ${tag.tag}`);
  const latest = previous[0];
  const revision = latest
    ? latest.nodePty.release.revision + Number(latest.nodePty.recipeKey !== key)
    : 0;
  return publicationFor(tag.version, revision, config.versioning.reserved);
}

export function buildRunName(key: string, revision: number): string {
  return `build-${key}-r${revision}`;
}

export function candidateState(
  candidate,
  versions,
  builds,
  publications,
  releases,
): SyncState {
  const record = versions[candidate.publication.version];
  if (
    record &&
    (record.nodePty?.recipeKey !== candidate.recipeKey ||
      record.nodePty?.upstream.sha !== candidate.sha)
  )
    return {
      state: "conflict",
      reason:
        "Existing npm version does not match the planned source and recipe",
    };
  const sealed = releases.find(
    (release) => release.tag_name === `v${candidate.publication.version}`,
  );
  if (record && sealed && !sealed.draft) return { state: "published" };
  const matching = builds.filter(
    (build) =>
      build.display_title ===
      buildRunName(candidate.recipeKey, candidate.publication.revision),
  );
  const active = matching.find((build) => build.status !== "completed");
  if (active)
    return { state: "building", runId: active.id, url: active.html_url };
  const built = matching.find((build) => build.conclusion === "success");
  if (!built) {
    if (matching.length)
      return {
        state: "build-failed",
        runId: matching[0].id,
        url: matching[0].html_url,
        reason: "Retry the failed jobs after inspecting the build log",
      };
    if (record)
      return {
        state: "conflict",
        reason: "npm version exists without a recoverable sealed build",
      };
    return { state: "queued" };
  }
  const publish = publications.filter(
    (entry) => entry.display_title === `publish-${built.id}`,
  );
  const running = publish.find((entry) => entry.status !== "completed");
  if (running)
    return {
      state: "publishing",
      runId: built.id,
      publicationRun: running.id,
      url: running.html_url,
    };
  if (publish.some((entry) => entry.conclusion === "failure"))
    return {
      state: "publish-failed",
      runId: built.id,
      publicationRun: publish[0].id,
      url: publish[0].html_url,
      reason: "Resume the original publication to reuse immutable tarballs",
    };
  if (publish.some((entry) => entry.conclusion === "success"))
    return {
      state: "registry-pending",
      runId: built.id,
      reason:
        "Successful publication is awaiting registry/release metadata visibility",
    };
  return { state: "built", runId: built.id, url: built.html_url };
}

async function dispatch(workflow: string, inputs, ref = "main") {
  const result = await github(
    `repos/${config.repository}/actions/workflows/${workflow}/dispatches`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2026-03-10",
      },
      body: JSON.stringify({ ref, inputs, return_run_details: true }),
    },
  );
  if (!result?.workflow_run_id)
    throw new Error("GitHub did not return the dispatched run ID");
  // Keep the detection lock until the run is queryable, preventing a second dispatch.
  await github(
    `repos/${config.repository}/actions/runs/${result.workflow_run_id}`,
  );
  return result.workflow_run_id;
}

async function publicationRef(runId: number): Promise<string> {
  const build = await github(
    `repos/${config.repository}/actions/runs/${runId}`,
  );
  if (build.head_branch !== "main" || !/^[a-f0-9]{40}$/.test(build.head_sha))
    throw new Error("Invalid publication source commit");
  const ref = `ci/${build.head_sha}`;
  const previous = await github(
    `repos/${config.repository}/git/ref/tags/${ref}`,
    { allow404: true },
  );
  if (previous) {
    if (
      previous.object.type !== "commit" ||
      previous.object.sha !== build.head_sha
    )
      throw new Error(`Publication source ref conflict ${ref}`);
  } else {
    await github(`repos/${config.repository}/git/refs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ref: `refs/tags/${ref}`, sha: build.head_sha }),
    });
  }
  return ref;
}

async function pinChanges() {
  if (process.env.GITHUB_ACTIONS !== "true") return;
  if (
    !run("git", ["diff", "--name-only", "--", "upstream-tags.json"], {
      capture: true,
    })
  )
    return;
  const head = await github(`repos/${config.repository}/commits/main`);
  if (head.sha !== process.env.GITHUB_SHA)
    throw new Error(
      "Checkout was superseded while inspecting upstream tags. Retry from current main.",
    );
  const file = await github(
    `repos/${config.repository}/contents/upstream-tags.json?ref=main`,
  );
  await github(`repos/${config.repository}/contents/upstream-tags.json`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message: "chore: pin observed upstream tags and CI profiles",
      branch: "main",
      sha: file.sha,
      content: readFileSync(join(root, "upstream-tags.json")).toString(
        "base64",
      ),
    }),
  });
}

async function main() {
  const detection = readJson(join(root, "dist/detection.json"));
  const [registry, builds, publications, releases] = await Promise.all([
    jsonRequest(
      `https://registry.npmjs.org/${encodeURIComponent(config.package)}`,
    ),
    githubPages(
      `repos/${config.repository}/actions/workflows/build.yml/runs?branch=main&event=workflow_dispatch`,
      "workflow_runs",
    ),
    githubPages(
      `repos/${config.repository}/actions/workflows/publish.yml/runs`,
      "workflow_runs",
    ),
    githubPages(`repos/${config.repository}/releases`),
  ]);
  const candidates = detection.candidates
    .map((tag): SyncCandidate => {
      const key = recipeKey(tag);
      const publication = candidatePublication(tag, registry.versions, key);
      const candidate = { ...tag, recipeKey: key, publication };
      if (!tag.ready || tag.api !== "node-api")
        return { ...candidate, state: "upstream-pending" };
      return {
        ...candidate,
        ...candidateState(
          candidate,
          registry.versions,
          builds,
          publications,
          releases,
        ),
      };
    })
    .sort((a, b) => semver.compare(a.version, b.version));
  const apply = process.env.DISPATCH_SYNC === "1" && config.sync.enabled;
  const plan = {
    minimumUpstream: config.sync.minimumUpstream,
    apply,
    candidates,
  };
  writeJson(join(root, "dist/sync-plan.json"), plan);
  if (apply) {
    if (candidates.some((candidate) => candidate.state === "conflict"))
      throw new Error(
        "Publication conflicts require review. See sync-plan.json.",
      );
    await pinChanges();
    let slots =
      config.sync.maxInFlight -
      candidates.filter((candidate) => candidate.state === "building").length;
    for (const candidate of candidates) {
      if (candidate.state === "queued" && slots > 0) {
        candidate.runId = await dispatch("build.yml", {
          upstream_tag: candidate.tag,
          revision: String(candidate.publication.revision),
          recipe_key: candidate.recipeKey,
          key: buildRunName(
            candidate.recipeKey,
            candidate.publication.revision,
          ),
        });
        candidate.state = "building";
        slots--;
      } else if (candidate.state === "built") {
        const artifacts = await githubPages(
          `repos/${config.repository}/actions/runs/${candidate.runId}/artifacts`,
          "artifacts",
        );
        if (
          artifacts.some(
            (artifact) =>
              artifact.name === "android-proof" && !artifact.expired,
          )
        ) {
          candidate.publicationRun = await dispatch(
            "publish.yml",
            {
              run_id: String(candidate.runId),
              dry_run: "false",
            },
            await publicationRef(candidate.runId),
          );
          candidate.state = "publishing";
        } else {
          candidate.state = "awaiting-android";
          candidate.reason =
            "Android/Bionic container proof is missing for this exact build.";
        }
      }
    }
  }
  writeJson(join(root, "dist/sync-plan.json"), plan);
  console.log(
    JSON.stringify(
      candidates.map(({ tag, publication, state, runId, reason }) => ({
        tag,
        version: publication.version,
        channel: publication.channel,
        state,
        runId,
        reason,
      })),
      null,
      2,
    ),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await main();
