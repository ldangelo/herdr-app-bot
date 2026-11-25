import { test } from "node:test";
import assert from "node:assert/strict";
import { assetFileName, bunTarget, mergeManifest, platformKey } from "./host-build-lib.mjs";

test("platform keys and file names", () => {
  assert.equal(platformKey("darwin", "arm64"), "darwin-arm64");
  assert.equal(platformKey("win32", "x64"), "windows-x64");
  assert.equal(platformKey("linux", "x64"), "linux-x64");
  assert.throws(() => platformKey("freebsd", "x64"), /no standalone host build/);
  assert.equal(assetFileName("darwin-arm64"), "herdr-bot-darwin-arm64");
  assert.equal(assetFileName("windows-x64"), "herdr-bot-windows-x64.exe");
  assert.equal(bunTarget("darwin-x64"), "bun-darwin-x64");
  assert.throws(() => bunTarget("plan9-mips"), /unknown host target/);
});

test("mergeManifest adds and replaces one platform, and never mixes versions", () => {
  const first = mergeManifest(null, "1.0.0", "darwin-arm64", { file: "a", sha256: "aa", size: 1 });
  assert.deepEqual(first, { version: "1.0.0", assets: { "darwin-arm64": { file: "a", sha256: "aa", size: 1 } } });
  const both = mergeManifest(first, "1.0.0", "linux-x64", { file: "b", sha256: "bb", size: 2 });
  assert.deepEqual(Object.keys(both.assets).sort(), ["darwin-arm64", "linux-x64"]);
  const rebuilt = mergeManifest(both, "1.0.0", "darwin-arm64", { file: "a", sha256: "cc", size: 3 });
  assert.equal(rebuilt.assets["darwin-arm64"].sha256, "cc");
  assert.equal(rebuilt.assets["linux-x64"].sha256, "bb");
  const next = mergeManifest(both, "1.1.0", "darwin-arm64", { file: "a", sha256: "dd", size: 4 });
  assert.deepEqual(Object.keys(next.assets), ["darwin-arm64"], "a new version starts over");
  assert.deepEqual(mergeManifest({ version: "1.0.0", assets: null }, "1.0.0", "linux-x64", { file: "b", sha256: "bb", size: 2 }).assets, { "linux-x64": { file: "b", sha256: "bb", size: 2 } });
});
