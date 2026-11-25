// Pure helpers for scripts/export-mod.mjs: what goes into the published mod repository, and checks that its recipe
// still describes it.

/** The only files of mod/herdr-bot that are published: its sources and manifest, never the files herdr-app generates. */
export function selectModFiles(names) {
  return names.filter((name) => name === "mod.json" || /^[A-Za-z0-9_-]+\.js$/.test(name)).sort();
}

export const RECIPE_SECTIONS = ["## What you see", "## How it behaves", "## Built from", "## Watch out", "## Done when"];

/** Problems with a RECIPE.md against herdr's format (a title, the preview, five fixed sections) and against the mod it describes. */
export function checkRecipe(text, { files, requiredHostVersion }) {
  const problems = [];
  if (!/^# \S/m.test(text)) problems.push("it has no `# Name` title");
  if (!text.includes("![") || !text.includes("(preview.png)")) problems.push("it does not show preview.png");
  let at = -1;
  for (const section of RECIPE_SECTIONS) {
    const found = text.indexOf(`\n${section}\n`);
    if (found < 0) problems.push(`it has no "${section}" section`);
    else if (found < at) problems.push(`"${section}" is out of order`);
    else at = found;
  }
  for (const file of files) {
    if (!text.includes(`\`${file}\``)) problems.push(`it does not mention ${file}`);
  }
  if (!text.includes(`host-v${requiredHostVersion}`)) problems.push(`it does not name the release host-v${requiredHostVersion} the mod downloads`);
  if (!/\*\*This mod runs programs, reaches the network/.test(text)) problems.push("it does not open with the warning about what the mod does");
  return problems;
}
