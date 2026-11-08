#!/usr/bin/env node
// Launcher for `harness ...` that works from any directory:
// prefers the compiled build (dist/) and otherwise runs the TypeScript sources through tsx.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const nodeArgs = ["--no-warnings=ExperimentalWarning"];
const dist = path.join(root, "dist", "index.js");
if (existsSync(dist)) {
  nodeArgs.push(dist);
} else {
  const require = createRequire(path.join(root, "package.json"));
  nodeArgs.push("--import", pathToFileURL(require.resolve("tsx")).href, path.join(root, "src", "index.ts"));
}
const child = spawn(process.execPath, [...nodeArgs, ...args], { stdio: "inherit", cwd: process.cwd(), env: process.env });
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
