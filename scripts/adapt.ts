import ts from "typescript";

export function compileEsm(source: string, filename: string): string {
  const result = ts.transpileModule(source, {
    fileName: filename,
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
    },
  });
  return result.outputText.replace(
    /(from\s+['"])(\.{1,2}\/[^'"]+)(['"])/g,
    (_match, before, specifier, after) => {
      const target = specifier.endsWith(".ts")
        ? specifier.slice(0, -3) + ".js"
        : /\.[a-z]+$/.test(specifier)
          ? specifier
          : specifier + ".js";
      return before + target + after;
    },
  );
}

export function adaptUpstream(source: string, filename: string): string {
  if (filename === "utils.ts") {
    const parsed = ts.createSourceFile(
      filename,
      source,
      ts.ScriptTarget.Latest,
      true,
    );
    const loader = parsed.statements.find(
      (statement) =>
        ts.isFunctionDeclaration(statement) &&
        statement.name?.text === "loadNativeModule",
    );
    if (!loader) throw new Error("Unreviewed upstream native loader structure");
    source =
      source.slice(0, loader.getStart(parsed)) +
      'export { loadNativeModule } from "../loader.js";\n' +
      source.slice(loader.end);
  }
  if (source.includes("__dirname")) {
    source =
      'import { fileURLToPath as distributionFileURLToPath } from "node:url";\nconst __dirname = distributionFileURLToPath(new URL(".", import.meta.url));\n' +
      source;
  }
  if (source.includes("require(")) {
    source =
      'import { createRequire as distributionCreateRequire } from "node:module";\nconst require = distributionCreateRequire(import.meta.url);\n' +
      source;
    source = source.replace(
      /require\(['"](\.\/[^'"]+)['"]\)/g,
      (_match, target) => `require('${target}.js')`,
    );
  }
  source = source.replace(
    "'conpty_console_list_agent'",
    "'conpty_console_list_agent.js'",
  );
  return compileEsm(source, filename);
}
