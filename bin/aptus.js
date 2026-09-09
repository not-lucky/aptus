#!/usr/bin/env node
// @fileoverview Aptus executable launcher for the gateway command line interface.
//
// This file launches the gateway by delegating to the TypeScript command line entry point in
// `src/bootstrap/cli.ts`. You invoke this file through the `aptus` binary name after installation,
// and the launcher resolves the entry point relative to its own location, forwards every command line
// argument unchanged, and mirrors the exit status of the child process.
//
// The launcher sits outside the application lifecycle. Startup validation, listener binding, and signal
// handling all live in `src/bootstrap/cli.ts` and `src/bootstrap/run.ts`, while this file owns only
// process delegation. The file imports the synchronous spawn helper from `node:child_process` and the path
// resolver from `node:path`, and no other module imports this file as a library.
//
// The design assumes that the Node.js runtime can execute TypeScript sources directly through type
// stripping, so no build step runs before delegation. Standard input and output are inherited by the child
// process, which means signals and terminal behavior reach the gateway unchanged.
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

// Resolve the TypeScript command line entry point relative to this launcher location.
const cliTs = resolve(import.meta.dirname, "..", "src", "bootstrap", "cli.ts");
// Forward every argument to the entry point with inherited standard input and output.
const result = spawnSync(process.execPath, [cliTs, ...process.argv.slice(2)], { stdio: "inherit" });
// Mirror the exit status of the child process, defaulting to zero when no status exists.
process.exit(result.status ?? 0);
