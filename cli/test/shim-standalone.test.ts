import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { installStandaloneShim, standaloneShimScript } from "../src/shim.ts";
import { isStandaloneBinary } from "../src/standalone.ts";
import { makeTempHome } from "../../core/test/helpers/temp-home.ts";

test("a compiled Bun program is recognised by its virtual filesystem", () => {
  assert.equal(isStandaloneBinary("file:///$bunfs/root/herdr-bot"), true);
  assert.equal(isStandaloneBinary("file:///B:/~BUN/root/herdr-bot.exe"), true);
  assert.equal(isStandaloneBinary("file:///Users/me/herdr-bot/cli/src/main.ts"), false);
});

test("a binary elsewhere gets a shim that runs it with the home set, and re-running changes nothing", () => {
  const temp = makeTempHome();
  try {
    const path = installStandaloneShim(temp.home, "/opt/herdr bot/it's here");
    assert.equal(path, join(temp.home, "bin", "herdr-bot"));
    const shim = readFileSync(path, "utf8");
    assert.equal(shim, standaloneShimScript("/opt/herdr bot/it's here", temp.home));
    assert.ok(shim.includes(`exec '/opt/herdr bot/it'\\''s here' "$@"`), "quotes survive");
    assert.equal(installStandaloneShim(temp.home, "/opt/herdr bot/it's here"), path);
    installStandaloneShim(temp.home, "/somewhere/else");
    assert.ok(readFileSync(path, "utf8").includes("/somewhere/else"), "an old shim of ours is replaced");
  } finally {
    temp.cleanup();
  }
});

test("a binary already at <home>/bin/herdr-bot is left alone, even when the paths differ only by a symlink", () => {
  const temp = makeTempHome();
  try {
    mkdirSync(join(temp.home, "bin"));
    const binary = join(temp.home, "bin", "herdr-bot");
    writeFileSync(binary, Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0, 1, 2, 3]));
    chmodSync(binary, 0o755);
    assert.equal(installStandaloneShim(temp.home, binary), binary);
    // The same file reached through a symlinked folder: the case macOS temp dirs and symlinked homes produce.
    const link = join(temp.home, "link");
    symlinkSync(join(temp.home, "bin"), link);
    assert.equal(installStandaloneShim(temp.home, join(link, "herdr-bot")), binary);
    assert.deepEqual([...readFileSync(binary)], [0xcf, 0xfa, 0xed, 0xfe, 0, 1, 2, 3], "still the binary");
  } finally {
    temp.cleanup();
  }
});

test("it refuses to replace a file that is not one of our shims", () => {
  const temp = makeTempHome();
  try {
    mkdirSync(join(temp.home, "bin"));
    const path = join(temp.home, "bin", "herdr-bot");
    writeFileSync(path, "#!/bin/bash\necho my own script\n");
    assert.throws(() => installStandaloneShim(temp.home, "/opt/herdr-bot"), /not a herdr-bot shim/);
    assert.equal(readFileSync(path, "utf8"), "#!/bin/bash\necho my own script\n");
    writeFileSync(path, Buffer.alloc(200 * 1024, 7));
    assert.throws(() => installStandaloneShim(temp.home, "/opt/herdr-bot"), /not a herdr-bot shim/);
    assert.equal(existsSync(path), true);
  } finally {
    temp.cleanup();
  }
});
