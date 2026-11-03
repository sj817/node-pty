import { createHash } from "node:crypto";

const affected = new Set([
  "95b07ef255b11532a2cb447b2e6387a3c0127efb",
  "ec5774601f5124928e9e96d7162c132766cc42f0",
]);
const fixedBy = "ac22bd8937fc3671687093123fce2a3104c4af7a";
const digest = (source: string) =>
  createHash("sha256").update(source).digest("hex");

export function adaptNativeSource(source: string, sha: string, os: string) {
  const patches = [];
  if (affected.has(sha) && ["linux", "android"].includes(os)) {
    const before = "#if defined(SYS_close_range)\n";
    const after =
      "#if defined(SYS_close_range) && defined(CLOSE_RANGE_CLOEXEC)\n";
    if (source.split(before).length !== 2)
      throw new Error("Unexpected historical close_range source");
    const adapted = source.replace(before, after);
    patches.push({
      id: "close-range-cloexec-guard",
      path: "src/unix/pty.cc",
      fixedBy,
      before: digest(source),
      after: digest(adapted),
    });
    return { source: adapted, patches };
  }
  return { source, patches };
}
