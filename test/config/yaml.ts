import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const REPO = resolve(import.meta.dirname, "..", "..");
const FIXTURE = join(REPO, "test", "fixtures", "config", "complete.yaml");

/**
 * The verbatim complete-sample YAML with exact unique-anchor replacements
 * applied. Every anchor must occur exactly once in the fixture; a repeated or
 * missing anchor throws instead of silently producing a wrong fixture.
 *
 * Key anchors:
 * - `"  root: ./traces"` — the Trace root; load tests always redirect it into
 *   a per-test tmp directory.
 * - `"  port: 8080"` / `"  port: 9090"` — free ports for process tests.
 * - `"    baseUrl: https://api.openai.com/v1/"` — URL-case fixtures.
 * - `"    aliases: [production-chat]"` — namespace-collision fixtures.
 * - `"    candidates: [gpt-main, claude-main]"` — candidate-case fixtures.
 * - `"        secret: ${OPENAI_CHAT_KEY_B}"` — duplicate-secret, invalid
 *   reference, and unset-reference fixtures (keys[1] of provider 0).
 * - `"      secret: ${APTUS_CLIENT_PRIMARY}"` — literal-secret fixtures.
 * - `"metrics:\n  enabled: true\n"` — missing-section fixtures.
 * - `"dryRun:\n  enabled: false\n"` — append `bogus: 1` after this block.
 */
export function completeYaml(replacements: Record<string, string> = {}): string {
  let text = readFileSync(FIXTURE, "utf8");
  for (const [anchor, replacement] of Object.entries(replacements)) {
    const occurrences = text.split(anchor).length - 1;
    if (occurrences !== 1) {
      throw new Error(`complete.yaml anchor ${JSON.stringify(anchor)} must occur exactly once, found ${occurrences}`);
    }
    text = text.replace(anchor, replacement);
  }
  return text;
}
