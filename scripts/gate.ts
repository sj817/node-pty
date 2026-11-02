import { config, github, githubPages, writeJson, root } from "./common.ts";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

export function evaluateChecks(
  sha,
  checks,
  statuses,
  required = config.requiredChecks,
  app = config.checkApp,
) {
  const reasons = [];
  for (const name of required) {
    const check = checks
      .filter(
        (c) => c.name === name && c.app?.slug === app && c.head_sha === sha,
      )
      .sort((a, b) => b.id - a.id)[0];
    if (!check) reasons.push(`${name}: missing for ${sha}`);
    else if (check.status !== "completed" || check.conclusion !== "success")
      reasons.push(`${name}: ${check.status}/${check.conclusion || "pending"}`);
  }
  // Additional checks owned by the upstream build provider also fail closed.
  const latest = new Map();
  for (const c of [...checks].sort((a, b) => b.id - a.id)) {
    if (c.head_sha === sha && c.app?.slug === app && !latest.has(c.name))
      latest.set(c.name, c);
  }
  for (const c of latest.values()) {
    if (
      !required.includes(c.name) &&
      (c.status !== "completed" || c.conclusion !== "success")
    )
      reasons.push(`${c.name}: ${c.status}/${c.conclusion}`);
  }
  for (const status of statuses)
    if (status.state !== "success")
      reasons.push(`${status.context}: ${status.state}`);
  return { ready: reasons.length === 0, reasons };
}

export async function resolveTag(tag, repository = config.upstream.repository) {
  const ref = await github(
    `repos/${repository}/git/ref/tags/${encodeURIComponent(tag)}`,
  );
  let object = ref.object;
  for (let depth = 0; object.type === "tag" && depth < 10; depth++)
    object = (await github(`repos/${repository}/git/tags/${object.sha}`))
      .object;
  if (object.type !== "commit" || !/^[a-f0-9]{40}$/.test(object.sha))
    throw new Error(`Invalid tag target ${tag}`);
  return object.sha;
}
export async function gate(upstream = config.upstream) {
  const sha = await resolveTag(upstream.tag);
  if (sha !== upstream.sha)
    throw new Error(
      `MOVED TAG ${upstream.tag}: expected ${upstream.sha}, now ${sha}. Publication stopped.`,
    );
  const base = `repos/${config.upstream.repository}/commits/${sha}`;
  const [checks, status] = await Promise.all([
    githubPages(`${base}/check-runs?filter=latest`, "check_runs"),
    github(`${base}/status`),
  ]);
  const result = {
    tag: upstream.tag,
    sha,
    ...evaluateChecks(sha, checks, status.statuses),
    checkedAt: new Date().toISOString(),
    checks: checks.map((c) => ({
      id: c.id,
      name: c.name,
      app: c.app?.slug,
      head_sha: c.head_sha,
      status: c.status,
      conclusion: c.conclusion,
      url: c.details_url,
    })),
  };
  return result;
}
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await gate();
  writeJson(join(root, "dist/gate.json"), result);
  console.log(JSON.stringify(result, null, 2));
  if (!result.ready) process.exitCode = 1;
}
