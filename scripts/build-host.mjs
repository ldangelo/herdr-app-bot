#!/usr/bin/env node
// Builds the standalone herdr-bot host: one self-contained executable that is the host AND the `herdr-bot` command
// (no Node, no repository checkout needed). Needs bun on PATH.
//
//   node scripts/build-host.mjs [--target darwin-arm64] [--out dist/host]
//
// Writes <out>/herdr-bot-<os>-<arch>[.exe], its .sha256, and merges an entry into <out>/manifest.json.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assetFileName, bunTarget, mergeManifest, platformKey } from "./host-build-lib.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] != null ? process.argv[index + 1] : fallback;
}

function sha256(path) {
  return new Promise((done, fail) => {
    const hash = createHash("sha256");
    createReadStream(path).on("data", (chunk) => hash.update(chunk)).on("error", fail).on("end", () => done(hash.digest("hex")));
  });
}

const key = option("target", platformKey(process.platform, process.arch));
const out = resolve(root, option("out", "dist/host"));
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const file = assetFileName(key);
const binary = join(out, file);

mkdirSync(out, { recursive: true });
const built = spawnSync("bun", ["build", join(root, "cli/src/main.ts"), "--compile", `--target=${bunTarget(key)}`, "--outfile", binary], { stdio: "inherit" });
if (built.error != null) throw new Error(`could not run bun (${built.error.message}); install it from https://bun.sh`);
if (built.status !== 0) process.exit(built.status ?? 1);

// A macOS executable must carry at least an ad-hoc signature (Apple silicon refuses to run an unsigned one), and bun
// does not sign a build for a different CPU. Signing is idempotent, and has to happen before the checksum is taken.
if (key.startsWith("darwin-")) {
  if (process.platform !== "darwin") throw new Error(`a ${key} host can only be built on macOS: it has to be code-signed`);
  const signed = spawnSync("codesign", ["--force", "--sign", "-", binary], { stdio: "inherit" });
  if (signed.status !== 0) process.exit(signed.status ?? 1);
}

const digest = await sha256(binary);
writeFileSync(`${binary}.sha256`, `${digest}  ${file}\n`);
const manifestPath = join(out, "manifest.json");
const existing = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : null;
writeFileSync(manifestPath, `${JSON.stringify(mergeManifest(existing, version, key, { file, sha256: digest, size: statSync(binary).size }), null, 2)}\n`);
process.stdout.write(`built ${binary}\n  sha256 ${digest}\n  manifest ${manifestPath}\n`);
