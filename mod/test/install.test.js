import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SOURCE, HostUnavailableError, describeSize, installHost, isAllowedSource, pickAsset, planInstall, platformKey } from "../herdr-bot/install.js";

const SHA = "a".repeat(64);
const manifest = (assets = { "darwin-arm64": { file: "herdr-bot-darwin-arm64", sha256: SHA, size: 88_000_000 } }) => JSON.stringify({ version: "1.3.0", assets });

function harness({ manifestText = manifest(), shasum = `${SHA}  /h/bin/.herdr-bot.download\n`, failing = null } = {}) {
  const calls = [];
  const steps = [];
  const exec = async (command, args) => {
    calls.push([command, ...args]);
    if (failing === command) return { code: 1, stdout: "", stderr: `${command} exploded` };
    return { code: 0, stdout: command === "shasum" ? shasum : "", stderr: "" };
  };
  const deps = { source: "https://example.test/releases/v1", botHome: "/h", platform: "macos", arch: "arm64", fetchText: async () => manifestText, exec, onStep: (step) => steps.push(step) };
  return { deps, calls, steps };
}

test("platformKey maps herdr's platform words", () => {
  assert.equal(platformKey("macos", "arm64"), "darwin-arm64");
  assert.equal(platformKey("linux", "x64"), "linux-x64");
  assert.equal(platformKey("windows", "x64"), "windows-x64");
});

test("only https, or http to this machine, may serve a program we will run", () => {
  for (const ok of [DEFAULT_SOURCE, "https://example.com/x", "http://127.0.0.1:8080/x", "http://localhost:9/x"]) assert.equal(isAllowedSource(ok), true, ok);
  for (const bad of ["http://example.com/x", "ftp://example.com/x", "file:///tmp/x", "javascript:alert(1)", "not a url", "", "http://127.0.0.1.evil.test/x"]) assert.equal(isAllowedSource(bad), false, bad);
});

test("pickAsset validates what it is about to trust", () => {
  assert.equal(pickAsset(JSON.parse(manifest()), "darwin-arm64").file, "herdr-bot-darwin-arm64");
  assert.throws(() => pickAsset(JSON.parse(manifest()), "linux-x64"), HostUnavailableError);
  assert.throws(() => pickAsset({ assets: { k: { file: "../evil", sha256: SHA } } }, "k"), /unsafe file/);
  assert.throws(() => pickAsset({ assets: { k: { file: "a/b", sha256: SHA } } }, "k"), /unsafe file/);
  assert.throws(() => pickAsset({ assets: { k: { file: "ok", sha256: "nope" } } }, "k"), /valid checksum/);
  assert.throws(() => pickAsset({ assets: { k: { file: "ok", sha256: SHA.toUpperCase() } } }, "k"), /valid checksum/);
  assert.throws(() => pickAsset(null, "k"), HostUnavailableError);
});

test("describeSize", () => {
  assert.equal(describeSize(88 * 1024 * 1024), "88 MB");
  assert.equal(describeSize(undefined), "a large file");
  assert.equal(describeSize(0), "a large file");
});

test("a good download is fetched, checked, made executable and moved into place", async () => {
  const { deps, calls, steps } = harness();
  const result = await installHost(deps);
  assert.deepEqual(result, { path: "/h/bin/herdr-bot", version: "1.3.0", sha256: SHA });
  assert.deepEqual(steps, ["manifest", "download", "verify", "install"]);
  assert.deepEqual(calls.map((call) => call[0]), ["mkdir", "curl", "shasum", "chmod", "mv"]);
  const curl = calls.find((call) => call[0] === "curl");
  assert.ok(curl.includes("--proto") && curl.includes("=https"), "https only, redirects included");
  assert.equal(curl.at(-1), "https://example.test/releases/v1/herdr-bot-darwin-arm64");
  assert.deepEqual(calls.find((call) => call[0] === "mv"), ["mv", "-f", "/h/bin/.herdr-bot.download", "/h/bin/herdr-bot"]);
});

test("a loopback http source skips the https-only flags, so a local test server works", async () => {
  const { deps, calls } = harness();
  await installHost({ ...deps, source: "http://127.0.0.1:5000/dist/" });
  const curl = calls.find((call) => call[0] === "curl");
  assert.equal(curl.includes("--proto"), false);
  assert.equal(curl.at(-1), "http://127.0.0.1:5000/dist/herdr-bot-darwin-arm64", "a trailing slash is tolerated");
});

test("a checksum mismatch discards the download and installs nothing", async () => {
  const { deps, calls } = harness({ shasum: `${"b".repeat(64)}  x\n` });
  await assert.rejects(installHost(deps), /download is damaged/);
  assert.deepEqual(calls.map((call) => call[0]).slice(-2), ["shasum", "rm"], "the partial file is removed");
  assert.equal(calls.some((call) => call[0] === "mv"), false);
  assert.equal(calls.some((call) => call[0] === "chmod"), false, "never made executable");
});

test("a failed download is discarded too, and says what failed", async () => {
  const { deps, calls } = harness({ failing: "curl" });
  await assert.rejects(installHost(deps), /curl failed: curl exploded/);
  assert.equal(calls.at(-1)[0], "rm");
  assert.equal(calls.some((call) => call[0] === "shasum"), false);
});

test("it refuses a non-https source before touching anything", async () => {
  const { deps, calls } = harness();
  await assert.rejects(installHost({ ...deps, source: "http://example.com/x" }), /not an https address/);
  assert.equal(calls.length, 0);
});

test("a missing platform, a bad manifest and Windows are reported plainly", async () => {
  await assert.rejects(installHost({ ...harness().deps, arch: "riscv64" }), /no herdr-bot host build for darwin-riscv64/);
  await assert.rejects(installHost({ ...harness({ manifestText: "not json" }).deps }), /could not read the host manifest/);
  const { deps } = harness();
  await assert.rejects(installHost({ ...deps, fetchText: async () => { throw new Error("404"); } }), /could not read the host manifest .*404/);
  await assert.rejects(installHost({ ...deps, platform: "windows", arch: "x64" }), /not supported on Windows/);
});

test("planInstall says what would be fetched without fetching the program, or why it cannot be", async () => {
  const fetchText = async () => manifest();
  assert.deepEqual(await planInstall({ source: "https://example.test/r", platform: "macos", arch: "arm64", fetchText }), { ok: true, version: "1.3.0", size: 88_000_000, key: "darwin-arm64" });
  const noSize = await planInstall({ source: "https://example.test/r", platform: "macos", arch: "arm64", fetchText: async () => manifest({ "darwin-arm64": { file: "f", sha256: SHA } }) });
  assert.equal(noSize.ok && noSize.size, null);
  const other = await planInstall({ source: "https://example.test/r", platform: "linux", arch: "x64", fetchText });
  assert.equal(other.ok, false);
  assert.match(other.reason, /no herdr-bot host build for linux-x64/);
  assert.match((await planInstall({ source: "http://example.com", platform: "macos", arch: "arm64", fetchText })).reason, /not an https address/);
  assert.match((await planInstall({ source: "https://example.test/r", platform: "windows", arch: "x64", fetchText })).reason, /Windows/);
  assert.match((await planInstall({ source: "https://example.test/r", platform: "macos", arch: "arm64", fetchText: async () => { throw new Error("offline"); } })).reason, /could not reach https:\/\/example.test\/r \(offline\)/);
});
