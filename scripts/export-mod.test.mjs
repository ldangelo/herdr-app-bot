import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { RECIPE_SECTIONS, checkRecipe, selectModFiles } from "./export-mod-lib.mjs";

const root = resolve(import.meta.dirname, "..");
const modFiles = selectModFiles(readdirSync(join(root, "mod", "herdr-bot")));
const requiredHostVersion = /REQUIRED_HOST_VERSION = "([^"]+)"/.exec(readFileSync(join(root, "mod/herdr-bot/version.js"), "utf8"))[1];
const recipe = readFileSync(join(root, "mod/publish/RECIPE.md"), "utf8");

test("only the mod's sources are published, never what herdr-app generates", () => {
  assert.deepEqual(selectModFiles(["main.js", "mod.json", "gpui-kit.d.ts", "jsconfig.json", "herdr.d.ts", "notes.md", "test", ".hidden.js", "a b.js", "client.js"]), ["client.js", "main.js", "mod.json"]);
  assert.ok(modFiles.includes("main.js") && modFiles.includes("mod.json"));
  assert.ok(!modFiles.some((name) => name.endsWith(".d.ts") || name === "jsconfig.json"));
});

test("RECIPE.md follows herdr's format and describes this mod: a new file or a new host version fails here until it is documented", () => {
  assert.deepEqual(checkRecipe(recipe, { files: modFiles, requiredHostVersion }), []);
});

test("checkRecipe reports each way a recipe can be wrong", () => {
  const ok = { files: ["main.js"], requiredHostVersion: "1.3.0" };
  const good = `# X\n\n![X](preview.png)\n\n**This mod runs programs, reaches the network and downloads.**\n\n${RECIPE_SECTIONS.map((s) => `${s}\n\ntext\n`).join("\n")}\n\`main.js\` and host-v1.3.0\n`;
  assert.deepEqual(checkRecipe(good, ok), []);
  assert.match(checkRecipe(good.replace("# X", "X"), ok).join(), /no `# Name` title/);
  assert.match(checkRecipe(good.replace("(preview.png)", "(x.png)"), ok).join(), /preview\.png/);
  assert.match(checkRecipe(good.replace("## Done when", "## Finished"), ok).join(), /no "## Done when" section/);
  const swapped = good.replace("## Watch out", "## TMP").replace("## Done when", "## Watch out").replace("## TMP", "## Done when");
  assert.match(checkRecipe(swapped, ok).join(), /out of order/);
  assert.match(checkRecipe(good.replace("`main.js`", "main"), ok).join(), /does not mention main\.js/);
  assert.match(checkRecipe(good.replace("host-v1.3.0", "host-v1.2.0"), ok).join(), /host-v1\.3\.0/);
  assert.match(checkRecipe(good.replace("**This mod runs programs, reaches the network", "**Hello"), ok).join(), /warning about what the mod does/);
});

test("the recipe and README name the release and disclose what the mod does", () => {
  const readme = readFileSync(join(root, "mod/publish/README.md"), "utf8");
  for (const needle of ["runs programs", "reaches the network", "downloads and runs an executable"]) assert.ok(readme.includes(needle), `README: ${needle}`);
  assert.ok(existsSync(join(root, "mod/publish/preview.png")));
  assert.ok(readFileSync(join(root, "mod/publish/preview.png")).subarray(1, 4).toString() === "PNG", "preview.png is a PNG");
});

test("export writes the layout herdr.dev expects, replaces a stale copy, and leaves other files alone", () => {
  const out = mkdtempSync(join(tmpdir(), "hb-export-"));
  try {
    writeFileSync(join(out, "keep.txt"), "mine");
    execFileSync(process.execPath, [join(root, "scripts/export-mod.mjs"), "--out", out], { encoding: "utf8" });
    assert.deepEqual(readdirSync(join(out, "mods/herdr-bot")).sort(), modFiles);
    for (const file of ["RECIPE.md", "README.md", "preview.png", "LICENSE", ".gitignore", "keep.txt"]) assert.ok(existsSync(join(out, file)), file);
    assert.ok(!existsSync(join(out, "layouts")), "no layouts/ folder");
    const ignore = readFileSync(join(out, ".gitignore"), "utf8");
    assert.ok(ignore.includes("mods/*/*.d.ts") && ignore.includes("mods/*/jsconfig.json"), "the files herdr-app generates are ignored");
    writeFileSync(join(out, "mods/herdr-bot/stale.js"), "old");
    execFileSync(process.execPath, [join(root, "scripts/export-mod.mjs"), "--out", out], { encoding: "utf8" });
    assert.ok(!existsSync(join(out, "mods/herdr-bot/stale.js")), "a stale file is replaced");
    assert.equal(readFileSync(join(out, "keep.txt"), "utf8"), "mine");
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test("export refuses a folder inside this repository", () => {
  assert.throws(() => execFileSync(process.execPath, [join(root, "scripts/export-mod.mjs"), "--out", join(root, "dist", "x")], { encoding: "utf8", stdio: "pipe" }), /inside this repository/);
});
