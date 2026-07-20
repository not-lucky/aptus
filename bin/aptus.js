#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const cliTs = resolve(import.meta.dirname, "..", "src", "bootstrap", "cli.ts");
const result = spawnSync(
  process.execPath,
  ["--disable-warning=DEP0205", "--import", "tsx", cliTs, ...process.argv.slice(2)],
  { stdio: "inherit" },
);
process.exit(result.status ?? 0);
