import { readdir, readFile } from "node:fs/promises";
import { extname, join, posix, relative } from "node:path";
import * as ts from "typescript";
import { describe, expect, it } from "vitest";

type Layer = "domain" | "ports" | "application" | "plugins" | "adapter" | "external";

const ALLOWED: Record<Exclude<Layer, "external" | "adapter">, ReadonlySet<Layer>> = {
  domain: new Set(["domain"]),
  ports: new Set(["domain", "ports"]),
  application: new Set(["domain", "ports", "application"]),
  plugins: new Set(["domain", "ports", "application", "plugins"]),
};
const FORBIDDEN_EXTERNAL = /^(?:express|(?:node:)?https?|(?:node:)?http|zod|js-yaml|yaml)$|(?:adapter|transport|openai|anthropic|google|azure|aws)/i;

interface Violation {
  kind: string;
  message: string;
}

function layerForPath(path: string): Layer {
  const normalized = path.split("\\").join("/");
  const match = normalized.match(/(?:^|\/)src\/([^/]+)(?:\/|$)/);
  if (!match) return "external";
  const layer = match[1];
  return layer === "domain" || layer === "ports" || layer === "application" || layer === "plugins" ? layer : "adapter";
}
function moduleSpecifier(node: ts.Node | undefined): string | undefined {
  if (node && ts.isStringLiteral(node)) return node.text;
  return undefined;
}

function importedSpecifiers(source: ts.SourceFile): Array<{ specifier: string; node: ts.Node }> {
  const result: Array<{ specifier: string; node: ts.Node }> = [];
  source.forEachChild((node) => {
    if (ts.isImportDeclaration(node)) {
      const specifier = moduleSpecifier(node.moduleSpecifier);
      if (specifier) result.push({ specifier, node });
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      const specifier = moduleSpecifier(node.moduleSpecifier);
      if (specifier) result.push({ specifier, node });
    }
  });
  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments.length === 1) {
      const specifier = moduleSpecifier(node.arguments[0]);
      if (specifier) result.push({ specifier, node });
    }
    ts.forEachChild(node, visit);
  }
  for (const statement of source.statements) ts.forEachChild(statement, visit);
  return result;
}


function resolveRelative(sourcePath: string, specifier: string): string {
  const withoutJs = specifier.endsWith(".js") ? specifier.slice(0, -3) + ".ts" : specifier;
  return posix.normalize(posix.resolve(posix.dirname(sourcePath.split("\\").join("/")), withoutJs));
}

function parseSource(sourcePath: string, sourceText: string): ts.SourceFile {
  return ts.createSourceFile(sourcePath, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

export function classifySource(sourcePath: string, sourceText: string, projectRoot = process.cwd()): Violation[] {
  const source = parseSource(sourcePath, sourceText);
  const fromLayer = layerForPath(sourcePath);
  const violations: Violation[] = [];
  for (const { specifier } of importedSpecifiers(source)) {
    const targetLayer = specifier.startsWith(".") ? layerForPath(resolveRelative(sourcePath, specifier)) : "external";
    if (targetLayer === "external" && (!specifier.startsWith(".") && FORBIDDEN_EXTERNAL.test(specifier))) {
      violations.push({ kind: "forbidden-external", message: `${fromLayer} imports forbidden external ${specifier}` });
    } else if (fromLayer !== "external" && fromLayer !== "adapter" && !ALLOWED[fromLayer].has(targetLayer)) {
      violations.push({ kind: "dependency-direction", message: `${fromLayer} imports ${targetLayer}` });
    }
  }
  let mutableSingleton = false;
  function inspect(node: ts.Node): void {
    if (ts.isPropertyDeclaration(node)) {
      const modifiers = ts.getModifiers(node);
      const staticProperty = modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword) ?? false;
      const readonlyProperty = modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ReadonlyKeyword) ?? false;
      if (staticProperty && !readonlyProperty && ts.isIdentifier(node.name) && node.name.text === "instance") mutableSingleton = true;
    }
    if (ts.isVariableStatement(node)) {
      const exported = ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false;
      if (exported) {
        for (const declaration of node.declarationList.declarations) {
          if (!ts.isIdentifier(declaration.name) || !["instance", "registry", "logger", "metrics", "configuration", "hookManager"].includes(declaration.name.text)) continue;
          if (declaration.initializer && (ts.isNewExpression(declaration.initializer) || ts.isObjectLiteralExpression(declaration.initializer))) mutableSingleton = true;
        }
      }
    }
    ts.forEachChild(node, inspect);
  }
  inspect(source);
  if (mutableSingleton) violations.push({ kind: "mutable-singleton", message: "exported mutable singleton" });
  return violations;
}

function hasJsDoc(node: ts.Node): boolean {
  return ts.getJSDocCommentsAndTags(node).length > 0;
}

export function undocumentedExports(sourcePath: string, sourceText: string): Violation[] {
  const source = parseSource(sourcePath, sourceText);
  const violations: Violation[] = [];
  function visit(node: ts.Node): void {
    const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
    const exported = modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false;
    if (exported && (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isClassDeclaration(node) || ts.isFunctionDeclaration(node) || ts.isVariableStatement(node)) && !hasJsDoc(node)) {
      violations.push({ kind: "missing-tsdoc", message: `undocumented export in ${sourcePath}` });
    }
    if (ts.isInterfaceDeclaration(node) && exported) {
      for (const member of node.members) if (!hasJsDoc(member)) violations.push({ kind: "missing-tsdoc-member", message: `undocumented interface member in ${sourcePath}` });
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return violations;
}

async function sourcePaths(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const paths = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sourcePaths(path) : extname(entry.name) === ".ts" ? [path] : [];
  }));
  return paths.flat();
}

describe("dependency classifiers", () => {
  it("rejects forbidden edges, mutable exports, and missing documentation", () => {
    expect(classifySource("/tmp/src/domain/bad.ts", 'import express from "express";')).toEqual([
      { kind: "forbidden-external", message: "domain imports forbidden external express" },
    ]);
    expect(classifySource("/tmp/src/ports/bad.ts", 'import { GatewayContext } from "../../src/application/lifecycle.js";')).toEqual([
      { kind: "dependency-direction", message: "ports imports application" },
    ]);
    expect(classifySource("/tmp/src/application/bad.ts", 'import adapter from "../adapter/x.js";')).toEqual([
      { kind: "dependency-direction", message: "application imports adapter" },
    ]);
    expect(classifySource("/tmp/src/plugins/bad.ts", 'import adapter from "../adapter/x.js";')).toEqual([
      { kind: "dependency-direction", message: "plugins imports adapter" },
    ]);
    expect(classifySource("/tmp/src/application/bad.ts", 'export { value } from "../adapter/value.js";')).toEqual([
      { kind: "dependency-direction", message: "application imports adapter" },
    ]);
    expect(classifySource("/tmp/src/application/bad.ts", 'const load = () => import("../adapter/value.js");')).toEqual([
      { kind: "dependency-direction", message: "application imports adapter" },
    ]);
    expect(classifySource("/tmp/src/application/bad.ts", "class Registry { static instance = new Registry(); }")).toEqual([
      { kind: "mutable-singleton", message: "exported mutable singleton" },
    ]);
    expect(classifySource("/tmp/src/application/bad.ts", "export const logger = new Logger();")).toEqual([
      { kind: "mutable-singleton", message: "exported mutable singleton" },
    ]);
    expect(classifySource("/tmp/src/application/ok.ts", "class Metadata { static readonly instance = {}; }")).toEqual([]);
    expect(undocumentedExports("/tmp/src/application/bad.ts", "export interface Missing { value: string };"))
      .toEqual([
        { kind: "missing-tsdoc", message: "undocumented export in /tmp/src/application/bad.ts" },
        { kind: "missing-tsdoc-member", message: "undocumented interface member in /tmp/src/application/bad.ts" },
      ]);
  });
});

describe("source dependency direction", () => {
  it("passes the pure source tree scan", async () => {
    const root = join(process.cwd(), "src");
    for (const layer of ["domain", "ports", "application", "plugins"] as const) {
      const directory = join(root, layer);
      try {
        const paths = await sourcePaths(directory);
        for (const path of paths) {
          const source = await readFile(path, "utf8");
          expect(classifySource(path, source), path).toEqual([]);
          const normalized = relative(root, path).split("\\").join("/");
          const taskThreePath = normalized === "domain/routing.ts"
            || normalized.startsWith("ports/")
            || normalized.startsWith("application/");
          if (taskThreePath) expect(undocumentedExports(path, source), path).toEqual([]);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  });

  it("loads all public barrels without network activity", async () => {
    let requests = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (() => {
      requests += 1;
      throw new Error("network access is forbidden");
    }) as typeof fetch;
    try {
      await import("../../src/domain/index.js");
      await import("../../src/ports/index.js");
      await import("../../src/application/index.js");
      expect(requests).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
