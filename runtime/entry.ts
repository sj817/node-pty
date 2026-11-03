import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { unpacked } from "./loader.ts";

const require = createRequire(import.meta.url);
// Load workers and fork agents from the package's real, unpacked directory.
// Node 22.14+ supports synchronous loading of ESM without top-level await.
const upstream = require(
  unpacked(fileURLToPath(new URL("./lib/index.js", import.meta.url))),
);

export const { spawn, fork, createTerminal, open, native } = upstream;
export default upstream;
