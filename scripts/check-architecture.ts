/**
 * @fileoverview Skott dependency graph checks that freeze the Aptus module architecture.
 *
 * This module implements the `npm run architecture` command, which rejects dependency cycles, unused source
 * files, and documented forbidden import edges. A forbidden edge is a directed import that the architecture
 * forbids even when the import would compile, for example when a domain module reaches into routing code. The
 * script builds two graphs so value edges and type edges receive different verdicts, then reports every
 * violation and exits with a nonzero status when any violation exists.
 *
 * The module sits outside the gateway request lifecycle. Admission, dispatch, relay, and observability code
 * never imports this script. You run the script from the repository root through the `architecture` package
 * script, and continuous integration runs it as a freeze check on every change. The module imports the
 * directory readers from `node:fs`, the path helpers from `node:path`, and the Skott graph builder from the
 * `skott` development dependency, and those imports exist only to walk the tree and evaluate the graph.
 *
 * The module assumes that the working directory is the repository root when the script runs, that every source
 * file lives under `src/` with a `.ts` suffix, and that type-only imports vanish at compilation, which is why
 * cycles and forbidden edges are evaluated on the value graph while unused files are evaluated on the type
 * graph.
 */

import { readdirSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import skott, { type SkottInstance } from "skott";

/**
 * Absolute path of the repository root, resolved from the location of this script.
 *
 * This constant anchors every later path computation, so graph node identifiers can be normalized to paths
 * relative to the repository. You never pass a different root at the call site. The value is derived from
 * `import.meta.dirname`, which points at the directory that holds this script.
 */
const REPO = resolve(import.meta.dirname, "..");

/**
 * Absolute path of the source tree that the architecture checks cover.
 *
 * This constant scopes file discovery and violation filtering to `src/`, so configuration, tests, and tooling
 * never produce violations. You read it together with `REPO`, from which it is derived by joining the fixed
 * `src` segment.
 */
const SRC = join(REPO, "src");

/**
 * Accumulated violation messages for the current run.
 *
 * This list collects one entry per unregistered file, dependency cycle, unused file, and forbidden edge. The
 * main routine prints the entries after all three checks complete and exits with a nonzero status when the
 * list is not empty. You never read this list before the run finishes, because checks append throughout.
 */
const FAILURES: string[] = [];

/**
 * Record one architecture violation for the final report.
 *
 * You call this function whenever a check finds an unregistered file, a cycle, an unused file, or a forbidden
 * edge. Use direct list inspection instead when you need the accumulated count, because this function only
 * appends. The function is synchronous and has no side effects beyond the append, so you can call it any
 * number of times and the final report preserves call order.
 *
 * @param message - Human readable violation description. The text must already contain the affected file or
 *   edge, and empty strings are accepted but produce an empty report line, so you always pass a nonempty
 *   description.
 * @returns Nothing. The function returns `undefined` and the violation is visible only through the shared
 *   list.
 */
function fail(message: string): void {
  FAILURES.push(message);
}

/**
 * Normalize a Skott node identifier to a path relative to the repository root.
 *
 * You call this function on every node identifier before comparison or display, because Skott emits
 * working-directory relative identifiers while the checks compare against repository relative prefixes. Use
 * {@link srcRel} instead when you need the path relative to `src/` for display. The function is synchronous
 * and has no side effects, so repeated calls with the same identifier yield equal results.
 *
 * @param id - Raw Skott node identifier. Absolute identifiers are made relative to the repository root, and
 *   relative identifiers pass through unchanged. Empty strings yield an empty result rather than a failure.
 * @returns Repository relative path with forward slashes. Never returns an absolute path.
 */
function normalizeId(id: string): string {
  const path = isAbsolute(id) ? relative(REPO, id) : id;
  return path.replaceAll("\\", "/");
}

/**
 * Report whether a normalized path falls under a repository relative prefix.
 *
 * You call this function to test membership of a file in an architecture layer such as `src/domain/`. Use a
 * forbidden edge predicate instead when you need a verdict on a pair of files. The function is synchronous and
 * has no side effects, and repeated calls with the same inputs yield the same verdict.
 *
 * @param path - Normalized repository relative path under test. The path must already use forward slashes, and
 *   paths outside `src/` never match a `src/` prefix.
 * @param prefix - Repository relative prefix that defines the layer, always with a trailing slash such as
 *   `src/domain/`. An empty prefix matches every path, so you always pass a nonempty layer prefix.
 * @returns `true` when the path starts with the prefix. Never returns `undefined`.
 */
function isUnder(path: string, prefix: string): boolean {
  return path.startsWith(prefix);
}

/**
 * Render a Skott node identifier as a path relative to `src/` for report display.
 *
 * You call this function when you format cycle and forbidden edge messages, because the `src/` prefix adds
 * noise to every entry. Use {@link normalizeId} instead when you need the repository relative path for
 * comparison. The function is synchronous and has no side effects, so formatting never affects the verdict.
 *
 * @param id - Raw Skott node identifier. Absolute and relative identifiers are both accepted, and identifiers
 *   outside `src/` pass through with the repository prefix intact.
 * @returns Source relative path with forward slashes. Never returns an absolute path.
 */
function srcRel(id: string): string {
  return normalizeId(id).replace(/^src\//, "");
}

/**
 * Collect every TypeScript source file under a directory in sorted order.
 *
 * You call this function once on the source root to build the expected file list for the registration check.
 * Use the Skott graph instead when you need the registered set, because this function reports what exists on
 * disk. The function is synchronous and performs directory input, and it has no side effects beyond reading.
 *
 * @param dir - Absolute directory to walk recursively. The directory must exist and be readable, and a missing
 *   directory raises the platform error from the directory reader rather than returning an empty list.
 * @returns Sorted list of paths relative to the source root with forward slashes. Never returns `undefined`,
 *   and an empty directory yields an empty list.
 */
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

/**
 * Build one Skott dependency graph over the repository.
 *
 * You call this function twice per run, once for the value graph and once for the type graph, because cycles
 * and forbidden edges apply to runtime edges while unused files consider every edge. Use the value graph for
 * cycle and edge checks and the type graph for the unused check. The function is asynchronous because graph
 * construction reads the filesystem, and it has no side effects beyond reading.
 *
 * @param typeOnly - Whether the graph tracks type-only edges in addition to value edges. Pass `false` for the
 *   runtime graph that backs cycle and forbidden edge checks, and `true` for the full graph that backs the
 *   unused file check. No other value is accepted.
 * @returns A promise that resolves to the built Skott instance. Never resolves to `undefined`.
 */
async function buildGraph(typeOnly: boolean): Promise<SkottInstance<unknown>> {
  return skott({
    // Discover the graph from the project rather than from a single entry file. The default expects an
    // explicit entry point, so this override selects whole repository analysis.
    entrypoint: undefined,
    dependencyTracking: {
      // Ignore third-party packages. The default follows them, so this override keeps the graph scoped to
      // first-party source files.
      thirdParty: false,
      // Ignore Node.js built-in modules. The default follows them, so this override keeps the graph scoped to
      // first-party source files.
      builtin: false,
      // Include or exclude type-only edges per the caller mode. The value graph erases them to match
      // compilation, while the type graph keeps them so an only-as-type reference still counts as use.
      typeOnly,
    },
    // Parse only TypeScript sources. The default covers JavaScript as well, so this override excludes the
    // launcher and any compiled output from the graph.
    fileExtensions: [".ts"],
    // Resolve path aliases and module settings from the project TypeScript configuration. The default looks
    // for the same file, so this entry records the choice explicitly.
    tsConfigPath: "./tsconfig.json",
    // Resolve workspace metadata from the project manifest. The default looks for the same file, so this
    // entry records the choice explicitly.
    manifestPath: "./package.json",
  });
}

/**
 * Documented forbidden edges as source and target prefix pairs.
 *
 * This constant holds one entry per forbidden layer transition, where an edge matches when the source falls
 * under the first prefix and the target falls under the second. You read it together with
 * {@link isForbiddenEdge}, which evaluates these pairs plus the predicates that prefixes cannot express. The
 * list is exhaustive for prefix expressible rules, so you extend this list rather than adding ad hoc checks
 * when a new layer boundary appears.
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

/**
 * Evaluate one value graph edge against the forbidden layer rules.
 *
 * You call this function on every `src/` to `src/` edge of the value graph, after normalization. Use the
 * `FORBIDDEN_EDGES` list instead when you need the raw prefix table. The function is synchronous and has no
 * side effects, so you can evaluate edges in any order.
 *
 * @param source - Normalized repository relative path of the importing file. The path must already use
 *   forward slashes, and paths outside `src/` never match a layer rule.
 * @param target - Normalized repository relative path of the imported file. The same normalization applies,
 *   and edges that leave `src/` are ignored by the caller before they reach this function.
 * @returns Human readable rule label when the edge is forbidden. Returns `undefined` when the edge is
 *   allowed.
 */
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

/**
 * Run the registration, cycle, unused file, and forbidden edge checks and report the verdict.
 *
 * You invoke this function once per process through the trailing call below, normally through the
 * `architecture` package script. The routine builds both graphs, evaluates every check, prints the module
 * count and any failures, and exits the process with a nonzero status when any failure exists. The function
 * is asynchronous because graph construction performs file input, and it terminates the process rather than
 * returning a reusable value, so you never call it as a library.
 *
 * @returns A promise that resolves when the report is printed and the process is about to exit cleanly.
 *   The promise never resolves to a value, and a graph construction failure rejects with the underlying
 *   error, which the trailing handler reports as a crash.
 */
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
