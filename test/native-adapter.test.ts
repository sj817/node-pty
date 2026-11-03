import test from "node:test";
import assert from "node:assert/strict";
import { adaptNativeSource } from "../scripts/native-adapter.ts";

test("historical Linux header adaptation backports the exact upstream guard", () => {
  const source =
    "#if defined(SYS_close_range)\n  syscall(SYS_close_range, 3, ~0U, CLOSE_RANGE_CLOEXEC);\n#endif\n";
  for (const sha of [
    "95b07ef255b11532a2cb447b2e6387a3c0127efb",
    "ec5774601f5124928e9e96d7162c132766cc42f0",
  ]) {
    for (const os of ["linux", "android"]) {
      const adapted = adaptNativeSource(source, sha, os);
      assert.match(
        adapted.source,
        /defined\(SYS_close_range\) && defined\(CLOSE_RANGE_CLOEXEC\)/,
      );
      assert.equal(adapted.patches.length, 1);
      assert.equal(
        adapted.patches[0].fixedBy,
        "ac22bd8937fc3671687093123fce2a3104c4af7a",
      );
      assert.notEqual(adapted.patches[0].before, adapted.patches[0].after);
    }
    for (const os of ["win32", "darwin"])
      assert.deepEqual(adaptNativeSource(source, sha, os), {
        source,
        patches: [],
      });
    assert.throws(() => adaptNativeSource("changed source", sha, "linux"));
  }
  assert.deepEqual(adaptNativeSource(source, "unreviewed", "linux"), {
    source,
    patches: [],
  });
});
