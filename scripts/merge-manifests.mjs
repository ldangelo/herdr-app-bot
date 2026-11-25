#!/usr/bin/env node
// Merges the per-platform manifests the build jobs produced into the one a release publishes, after checking that every
// asset it names is present next to it with exactly the checksum it claims.
//
//   node scripts/merge-manifests.mjs --out dist/release dist/host-darwin-arm64 dist/host-linux-x64 ...
//
// Each argument is a folder holding manifest.json and the binaries; --out receives the binaries, their .sha256 files
// and the merged manifest.json.
import { copyFileSync, createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { mergeManifests } from "./host-build-lib.mjs";

const args = process.argv.slice(2);
const outAt = args.indexOf("--out");
if (outAt < 0 || args[outAt + 1] == null) throw new Error("usage: merge-manifests.mjs --out <dir> <folder>...");
const out = resolve(args[outAt + 1]);
const folders = args.filter((_, index) => index !== outAt && index !== outAt + 1).map((folder) => resolve(folder));
if (folders.length === 0) throw new Error("no input folders");

const sha256 = (path) => new Promise((done, fail) => {
  const hash = createHash("sha256");
  createReadStream(path).on("data", (chunk) => hash.update(chunk)).on("error", fail).on("end", () => done(hash.digest("hex")));
});

mkdirSync(out, { recursive: true });
const manifests = [];
for (const folder of folders) {
  const manifest = JSON.parse(readFileSync(join(folder, "manifest.json"), "utf8"));
  for (const [key, asset] of Object.entries(manifest.assets ?? {})) {
    const file = join(folder, asset.file);
    if (!existsSync(file)) throw new Error(`${key}: ${asset.file} is not in ${folder}`);
    const actual = await sha256(file);
    if (actual !== asset.sha256) throw new Error(`${key}: ${asset.file} does not match its manifest checksum (${actual} vs ${asset.sha256})`);
    copyFileSync(file, join(out, asset.file));
    writeFileSync(join(out, `${asset.file}.sha256`), `${actual}  ${asset.file}\n`);
  }
  manifests.push(manifest);
}
const merged = mergeManifests(manifests);
writeFileSync(join(out, "manifest.json"), `${JSON.stringify(merged, null, 2)}\n`);
process.stdout.write(`merged ${Object.keys(merged.assets).join(", ")} (version ${merged.version}) into ${out}\n${readdirSync(out).map((name) => `  ${name}`).join("\n")}\n`);
