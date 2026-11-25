#!/usr/bin/env node
// Assembles the repository that publishes the mod to herdr.dev/mods (topic `herdr-mod`):
//
//   <out>/mods/herdr-bot/   the mod's sources and mod.json
//   <out>/RECIPE.md  <out>/README.md  <out>/preview.png  <out>/LICENSE  <out>/.gitignore
//
//   node scripts/export-mod.mjs --out ../herdr-bot-mod
//
// <out> is normally a checkout of that repository: its `mods/herdr-bot/` and the four root files are replaced, anything
// else (.git, ...) is left alone. The recipe is checked against the mod first, so a stale one is never published.
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { checkRecipe, selectModFiles } from "./export-mod-lib.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outAt = process.argv.indexOf("--out");
if (outAt < 0 || process.argv[outAt + 1] == null) throw new Error("usage: export-mod.mjs --out <dir>");
const out = resolve(process.argv[outAt + 1]);
if (out === root || out.startsWith(root + sep)) throw new Error(`${out} is inside this repository; export to a separate folder`);

const source = join(root, "mod", "herdr-bot");
const files = selectModFiles(readdirSync(source));
const version = /REQUIRED_HOST_VERSION = "([^"]+)"/.exec(readFileSync(join(source, "version.js"), "utf8"))?.[1];
if (version == null) throw new Error("could not read REQUIRED_HOST_VERSION from mod/herdr-bot/version.js");
const recipe = readFileSync(join(root, "mod", "publish", "RECIPE.md"), "utf8");
const problems = checkRecipe(recipe, { files, requiredHostVersion: version });
if (problems.length > 0) throw new Error(`RECIPE.md does not match the mod:\n  - ${problems.join("\n  - ")}`);

const target = join(out, "mods", "herdr-bot");
mkdirSync(out, { recursive: true });
if (existsSync(target)) rmSync(target, { recursive: true });
mkdirSync(target, { recursive: true });
for (const file of files) copyFileSync(join(source, file), join(target, file));
for (const [from, to] of [["mod/publish/RECIPE.md", "RECIPE.md"], ["mod/publish/README.md", "README.md"], ["mod/publish/preview.png", "preview.png"], ["mod/publish/gitignore", ".gitignore"], ["LICENSE", "LICENSE"]]) copyFileSync(join(root, from), join(out, to));
process.stdout.write(`exported to ${out}\n  mods/herdr-bot: ${files.join(" ")}\n  RECIPE.md README.md preview.png LICENSE .gitignore (mod needs host ${version})\n`);
