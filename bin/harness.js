#!/usr/bin/env node
// Thin launcher so `npx harness ...` / `./bin/harness.js ...` works without a build step.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const child = spawn(process.execPath, ["--no-warnings=ExperimentalWarning", "--import", "tsx", path.join(root, "src/index.ts"), ...process.argv.slice(2)], { stdio: "inherit", cwd: process.cwd(), env: process.env });
child.on("exit", (code) => process.exit(code ?? 0));
