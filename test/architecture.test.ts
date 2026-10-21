import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import ts from "typescript";

const root = resolve(import.meta.dir, "../src");
const files = [...new Bun.Glob("**/*.ts").scanSync(root)].filter((file) => !file.endsWith(".d.ts"));

/** Inspect emitted code so type-only contracts do not count as runtime dependencies. */
function runtime(file: string) {
  const { outputText } = ts.transpileModule(readFileSync(resolve(root, file), "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
  });
  const ast = ts.createSourceFile(file, outputText, ts.ScriptTarget.ESNext, true);
  const imports: string[] = [];
  function visit(node: ts.Node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      imports.push(node.moduleSpecifier.text);
    }
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || node.expression.getText(ast) === "require")) {
      const arg = node.arguments[0];
      imports.push(arg && ts.isStringLiteral(arg) ? arg.text : "<dynamic dependency>");
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  return { imports, ast };
}

test("views and domain rules stay free of runtime services and I/O", () => {
  const errors: string[] = [];
  const pureFiles = files.filter((file) => file.startsWith("web/views/") || file.startsWith("domain/") || ["web/setup.ts", "triage/brief-template.ts"].includes(file));
  for (const file of pureFiles) {
    const { imports, ast } = runtime(file);
    for (const spec of imports) {
      const target = spec.startsWith(".") ? relative(root, resolve(root, dirname(file), spec)) : spec;
      const domain = target.startsWith("domain/");
      const viewDependency = target.startsWith("web/views/") || target.startsWith("web/assets/") || target === "web/setup";
      if (!domain && !(file.startsWith("web/") && viewDependency)) errors.push(`${file} imports ${spec}`);
    }
    // Prevent bypassing imports with Bun.file/spawn, fetch, process.env, etc.
    function check(node: ts.Node) {
      const propertyName = node.parent && ts.isPropertyAccessExpression(node.parent) && node.parent.name === node;
      if (ts.isIdentifier(node) && !propertyName && ["Bun", "process", "fetch", "globalThis", "require", "eval"].includes(node.text)) {
        errors.push(`${file} uses ${node.text}`);
      }
      ts.forEachChild(node, check);
    }
    check(ast);
  }
  expect(errors).toEqual([]);
});

test("non-web services never depend on presentation modules", () => {
  const errors: string[] = [];
  for (const file of files.filter((file) => !file.startsWith("web/") && !file.startsWith("app/") && file !== "cli.ts")) {
    for (const spec of runtime(file).imports) {
      if (spec.startsWith(".") && relative(root, resolve(root, dirname(file), spec)).startsWith("web/")) errors.push(`${file} imports ${spec}`);
    }
  }
  expect(errors).toEqual([]);
});
