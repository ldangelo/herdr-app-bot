import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DEFAULT_SOURCE } from "../herdr-bot/install.js";
import { REQUIRED_HOST_VERSION, compareVersions, describeVersionGap, isHostCurrent, parseVersion, sourceForVersion } from "../herdr-bot/version.js";

const pkg = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../package.json"), "utf8"));

test("the mod requires the host version in package.json: bump them together", () => {
  assert.equal(REQUIRED_HOST_VERSION, pkg.version);
});

test("the default download is the release for exactly the required version, never 'latest'", () => {
  assert.equal(DEFAULT_SOURCE, `https://github.com/ldangelo/herdr-app-bot/releases/download/host-v${pkg.version}`);
  assert.ok(!DEFAULT_SOURCE.includes("latest"));
  assert.equal(sourceForVersion("2.0.1", "https://x.test/d"), "https://x.test/d/host-v2.0.1");
});

test("parseVersion accepts plain semver only", () => {
  assert.deepEqual(parseVersion("1.4.2"), [1, 4, 2]);
  assert.deepEqual(parseVersion(" 10.0.31 "), [10, 0, 31]);
  for (const bad of ["1.4", "1.4.2-beta", "v1.4.2", "", "a.b.c", null, undefined, 3]) assert.equal(parseVersion(bad), null, String(bad));
});

test("compareVersions orders by major, minor, patch, numerically", () => {
  assert.ok(compareVersions("1.10.0", "1.9.9") > 0, "10 is bigger than 9, not 'smaller as text'");
  assert.ok(compareVersions("1.3.0", "1.3.1") < 0);
  assert.equal(compareVersions("2.0.0", "2.0.0"), 0);
  assert.ok(compareVersions("2.0.0", "1.99.99") > 0);
  assert.equal(compareVersions("1.0.0", "garbage"), null);
});

test("a host is current when it has the same major and is at least as new", () => {
  assert.equal(isHostCurrent("1.3.0", "1.3.0"), true);
  assert.equal(isHostCurrent("1.3.5", "1.3.0"), true);
  assert.equal(isHostCurrent("1.4.0", "1.3.0"), true, "a newer minor is backward compatible");
  assert.equal(isHostCurrent("1.2.9", "1.3.0"), false);
  assert.equal(isHostCurrent("2.0.0", "1.3.0"), false, "a different major is not assumed compatible");
  assert.equal(isHostCurrent("0.9.0", "1.3.0"), false);
  assert.equal(isHostCurrent(null, "1.3.0"), false, "a host that sends no version predates versions");
  assert.equal(isHostCurrent("not-a-version", "1.3.0"), false);
  assert.equal(isHostCurrent(pkg.version), true, "this repository's own host satisfies this mod");
});

test("the update prompt explains which way it is out of step", () => {
  assert.match(describeVersionGap("1.2.0", "1.3.0"), /1\.2\.0.* older .*1\.3\.0/);
  assert.match(describeVersionGap(null, "1.3.0"), /too old to say which version/);
  assert.match(describeVersionGap("2.0.0", "1.3.0"), /newer major .*Update the herdr-bot mod/);
});
