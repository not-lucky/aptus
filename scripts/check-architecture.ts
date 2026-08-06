/**
 * `npm run architecture` — skott-based architecture freeze checks.
 *
 * Implements architecture "Dependency rules": skott must reject
 * cycles, unused source files, and the documented forbidden import edges.
 * Runs on plain Node type stripping, matching the CLI entrypoint.
 *
 * Two graphs are built:
 *  - value graph (`typeOnly: false`): runtime import edges. Cycles and the
 *    documented forbidden edges are evaluated here; type-only references are
 *    erased at compile time and the doc's forbidden-edge list is exhaustive.
 *  - type graph (`typeOnly: true`): every edge including type-only imports.
 *    A file is "unused" only when nothing at all imports it.
 */
import { readdirSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import skott, { type SkottInstance } from "skott";

const REPO = resolve(import.meta.dirname, "..");
const SRC = join(REPO, "src");

const FAILURES: string[] = [];

function fail(message: string): void {
  FAILURES.push(message);
}

/** Skott node ids are cwd-relative; normalize them to repo-relative paths. */
function normalizeId(id: string): string {
  const path = isAbsolute(id) ? relative(REPO, id) : id;
  return path.replaceAll("\\", "/");
}

function isUnder(path: string, prefix: string): boolean {
  return path.startsWith(prefix);
}

/** src-relative module path for one src file. */
function srcRel(id: string): string {
  return normalizeId(id).replace(/^src\//, "");
}

function walkTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkTsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      out.push(relative(SRC, full).replaceAll("\\", "/"));
    }
  }
  return out.sort();
}

async function buildGraph(typeOnly: boolean): Promise<SkottInstance<unknown>> {
  return skott({
    entrypoint: undefined,
    dependencyTracking: { thirdParty: false, builtin: false, typeOnly },
    fileExtensions: [".ts"],
    tsConfigPath: "./tsconfig.json",
    manifestPath: "./package.json",
  });
}

/**
 * Documented forbidden edges. Each entry is `[source prefix, target prefix]`;
 * an edge matches when both ends fall under the prefixes.
 */
const FORBIDDEN_EDGES: ReadonlyArray<readonly [string, string]> = [
  ["src/domain/", "src/http/"],
  ["src/domain/", "src/routing/"],
  ["src/domain/", "src/providers/"],
  ["src/domain/", "src/translation/"],
  ["src/domain/", "src/observability/"],
  ["src/http/", "src/providers/"],
  ["src/http/", "src/translation/"],
  ["src/providers/openai-chat/", "src/providers/openai-responses/"],
  ["src/providers/openai-chat/", "src/providers/anthropic-messages/"],
  ["src/providers/openai-responses/", "src/providers/openai-chat/"],
  ["src/providers/openai-responses/", "src/providers/anthropic-messages/"],
  ["src/providers/anthropic-messages/", "src/providers/openai-chat/"],
  ["src/providers/anthropic-messages/", "src/providers/openai-responses/"],
  ["src/providers/", "src/translation/"],
  ["src/routing/", "src/providers/"],
  ["src/observability/", "src/routing/"],
  ["src/observability/", "src/translation/"],
  ["src/translation/", "src/routing/"],
  ["src/translation/", "src/http/"],
];

/** Forbidden edge predicates that cannot be expressed as prefix pairs. */
function isForbiddenEdge(source: string, target: string): string | undefined {
  const pair = FORBIDDEN_EDGES.find(([from, to]) => isUnder(source, from) && isUnder(target, to));
  if (pair !== undefined) {
    return `${pair[0]} -> ${pair[1]}`;
  }
  if (isUnder(target, "src/bootstrap/") && !isUnder(source, "src/bootstrap/")) {
    return "src/* -> src/bootstrap/";
  }
  if (
    isUnder(target, "src/translation/") &&
    !isUnder(source, "src/translation/") &&
    !isUnder(source, "src/routing/") &&
    !isUnder(source, "src/bootstrap/")
  ) {
    return "src/* (except routing, bootstrap) -> src/translation/";
  }
  if (isUnder(target, "src/testing/") && !isUnder(source, "src/testing/")) {
    return "src/* -> src/testing/";
  }
  return undefined;
}

async function main(): Promise<void> {
  console.log("check-architecture:");
  const valueGraph = (await buildGraph(false)).useGraph();
  const typeGraph = (await buildGraph(true)).useGraph();

  const srcFiles = walkTsFiles(SRC);
  const registered = new Set<string>(
    Object.keys(valueGraph.getNodes())
      .map((id) => normalizeId(id))
      .filter((id) => isUnder(id, "src/")),
  );
  const unregistered = srcFiles.filter((file) => !registered.has(`src/${file}`));
  if (unregistered.length > 0) {
    for (const file of unregistered) {
      fail(`unregistered src file: ${file}`);
    }
  }

  const cycles = valueGraph.findCircularDependencies();
  for (const cycle of cycles) {
    fail(`cycle: ${cycle.map((id) => srcRel(id)).join(" -> ")}`);
  }

  const unused = typeGraph
    .collectUnusedFiles()
    .map((id) => normalizeId(id))
    .filter((id) => isUnder(id, "src/"))
    .map((id) => srcRel(id));
  for (const file of unused) {
    fail(`unused src file: ${file}`);
  }

  const nodes = valueGraph.getNodes();
  for (const [sourceId, node] of Object.entries(nodes)) {
    const source = normalizeId(sourceId);
    if (!isUnder(source, "src/")) {
      continue;
    }
    for (const targetId of node.adjacentTo) {
      const target = normalizeId(targetId);
      if (!isUnder(target, "src/")) {
        continue;
      }
      const rule = isForbiddenEdge(source, target);
      if (rule !== undefined) {
        fail(`forbidden edge (${rule}): ${srcRel(source)} -> ${srcRel(target)}`);
      }
    }
  }

  console.log(`  src modules: ${registered.size}`);
  if (FAILURES.length > 0) {
    for (const message of FAILURES) {
      console.error(`  FAIL ${message}`);
    }
    process.exit(1);
  }
  console.log("  no cycles, no unused files, no forbidden edges");
  console.log("  all checks passed");
}

void main().catch((err: unknown) => {
  console.error(`check-architecture crashed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  process.exit(1);
});
