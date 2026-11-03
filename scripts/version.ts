import semver from "semver";

export type Publication = {
  mode: "release" | "test";
  version: string;
  channel: "latest" | "next";
  revision: number;
};

export function releaseVersion(upstream: string, revision: number): string {
  const source = semver.parse(upstream);
  if (
    !source ||
    !Number.isSafeInteger(revision) ||
    revision < 0 ||
    revision >= 1000
  )
    throw new Error("Invalid upstream version or downstream revision");
  if (!Number.isSafeInteger(source.patch + revision))
    throw new Error("Version exceeds the supported patch range");
  if (revision === 0) return source.version;
  if (source.prerelease.length) return `${source.version}.${revision}`;
  return `${source.major}.${source.minor}.${source.patch + revision}`;
}

export function releaseTag(
  publication: Publication,
  upstream?: string,
): string {
  // Already published npm versions are immutable. Their corrected GitHub tags
  // omit the old automatic suffix while their manifests retain the npm identity.
  const version =
    publication.mode === "release" &&
    publication.revision === 0 &&
    upstream &&
    publication.version === `${upstream}.qwqo.0`
      ? upstream
      : publication.version;
  return `v${version}`;
}

export function publicationFor(
  upstream: string,
  revision = 0,
  reserved: string[] = [],
  testVersion?: string,
): Publication {
  if (testVersion) {
    assertTestPublication(testVersion, "next");
    return { mode: "test", version: testVersion, channel: "next", revision };
  }
  while (reserved.includes(releaseVersion(upstream, revision))) revision++;
  return {
    mode: "release",
    version: releaseVersion(upstream, revision),
    channel: semver.prerelease(upstream) ? "next" : "latest",
    revision,
  };
}

export function assertTestPublication(value: string, tag: string): void {
  if (!/^0\.0\.(?:[1-9]|[1-9][0-9]|100)$/.test(value) || tag !== "next")
    throw new Error(
      "Test publishing is restricted to 0.0.1 through 0.0.100 under the next tag",
    );
}

export function assertPublication(value: string, tag: string): void {
  if (/^0\.0\./.test(value)) return assertTestPublication(value, tag);
  if (
    !semver.valid(value) ||
    tag !== (semver.prerelease(value) ? "next" : "latest")
  )
    throw new Error(
      "Stable packages must use latest and prereleases must use next",
    );
}

export function shouldPromote(current, candidate, channel: string): boolean {
  if (!current) return true;
  if (current.version === candidate.version) return false;
  const previous = current.nodePty;
  const incoming = candidate.nodePty;
  if (incoming?.release?.channel !== channel)
    throw new Error("Candidate publication channel mismatch");
  if (previous?.release?.mode !== "release") {
    if (!/^0\.0\./.test(current.version))
      throw new Error("Unrecognized existing dist-tag target");
    return true;
  }
  if (incoming.release.mode === "test") return false;
  if (previous.release.channel !== channel)
    throw new Error("Existing dist-tag has the wrong release channel");
  const compared = semver.compare(
    incoming.upstream.version,
    previous.upstream.version,
  );
  if (compared !== 0) return compared > 0;
  if (incoming.upstream.sha !== previous.upstream.sha)
    throw new Error("Same upstream version has conflicting source SHAs");
  return incoming.release.revision > previous.release.revision;
}
