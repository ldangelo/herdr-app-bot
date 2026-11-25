import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installHost, platformKey } from "../herdr-bot/install.js";

// The installer against the real curl, shasum and mv, and a real local HTTP server: what the unit tests' fakes cannot show.
const haveTools = (() => { try { execFileSync("curl", ["--version"], { stdio: "ignore" }); execFileSync("shasum", ["--version"], { stdio: "ignore" }); return true; } catch { return false; } })();

const run = (command, args) => new Promise((resolve) => execFile(command, args, { encoding: "utf8" }, (error, stdout, stderr) => resolve({ code: error == null ? 0 : typeof error.code === "number" ? error.code : 1, stdout, stderr })));
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

function serve(files) {
  const server = createServer((request, response) => {
    const body = files[request.url ?? ""];
    if (body == null) { response.writeHead(404).end("no"); return; }
    response.writeHead(200, { "content-type": "application/octet-stream" }).end(body);
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((done) => server.close(done)) })));
}

const key = platformKey(process.platform === "darwin" ? "macos" : process.platform, process.arch);
const platform = process.platform === "darwin" ? "macos" : process.platform;

async function withInstall({ served, manifestFor }, check) {
  const home = mkdtempSync(join(tmpdir(), "hb-install-"));
  const server = await serve(served);
  try {
    await check({ home, source: server.url, manifest: manifestFor });
  } finally {
    await server.close();
    rmSync(home, { recursive: true, force: true });
  }
}

test("installs a real download: bytes intact, executable, no partial file left behind", { skip: !haveTools }, async () => {
  const binary = Buffer.from("#!/bin/sh\necho installed-ok\n");
  const manifest = JSON.stringify({ version: "9.9.9", assets: { [key]: { file: "herdr-bot-test", sha256: sha(binary), size: binary.length } } });
  await withInstall({ served: { "/manifest.json": manifest, "/herdr-bot-test": binary } }, async ({ home, source }) => {
    const result = await installHost({ source, botHome: home, platform, arch: process.arch, fetchText: async (url) => (await fetch(url)).text(), exec: run });
    assert.equal(result.path, join(home, "bin", "herdr-bot"));
    assert.equal(result.version, "9.9.9");
    assert.deepEqual(readFileSync(result.path), binary);
    assert.ok((statSync(result.path).mode & 0o111) !== 0, "executable");
    assert.deepEqual(readdirSync(join(home, "bin")), ["herdr-bot"], "the .download file is gone");
    assert.equal(execFileSync(result.path, { encoding: "utf8" }).trim(), "installed-ok", "and it runs");
  });
});

test("a corrupted download is rejected by the real shasum and nothing is installed", { skip: !haveTools }, async () => {
  const good = Buffer.from("#!/bin/sh\necho good\n");
  const manifest = JSON.stringify({ version: "9.9.9", assets: { [key]: { file: "herdr-bot-test", sha256: sha(good), size: good.length } } });
  await withInstall({ served: { "/manifest.json": manifest, "/herdr-bot-test": Buffer.from("#!/bin/sh\necho EVIL\n") } }, async ({ home, source }) => {
    await assert.rejects(installHost({ source, botHome: home, platform, arch: process.arch, fetchText: async (url) => (await fetch(url)).text(), exec: run }), /download is damaged/);
    assert.deepEqual(readdirSync(join(home, "bin")), [], "no binary, and the partial file was removed");
  });
});

test("a missing file on the server fails cleanly", { skip: !haveTools }, async () => {
  const manifest = JSON.stringify({ version: "9.9.9", assets: { [key]: { file: "herdr-bot-test", sha256: "c".repeat(64), size: 1 } } });
  await withInstall({ served: { "/manifest.json": manifest } }, async ({ home, source }) => {
    await assert.rejects(installHost({ source, botHome: home, platform, arch: process.arch, fetchText: async (url) => (await fetch(url)).text(), exec: run }), /curl failed/);
    assert.deepEqual(readdirSync(join(home, "bin")), []);
  });
});

test("a replaced install over an existing binary is atomic: the old one is swapped, not partly overwritten", { skip: !haveTools }, async () => {
  const binary = Buffer.from("#!/bin/sh\necho v2\n");
  const manifest = JSON.stringify({ version: "2.0.0", assets: { [key]: { file: "herdr-bot-test", sha256: sha(binary), size: binary.length } } });
  await withInstall({ served: { "/manifest.json": manifest, "/herdr-bot-test": binary } }, async ({ home, source }) => {
    await run("mkdir", ["-p", join(home, "bin")]);
    writeFileSync(join(home, "bin", "herdr-bot"), "#!/bin/sh\necho v1\n");
    chmodSync(join(home, "bin", "herdr-bot"), 0o755);
    await installHost({ source, botHome: home, platform, arch: process.arch, fetchText: async (url) => (await fetch(url)).text(), exec: run });
    assert.equal(execFileSync(join(home, "bin", "herdr-bot"), { encoding: "utf8" }).trim(), "v2");
  });
});

// The real thing: `HERDR_BOT_HOST_DIST=<dir with manifest.json and the built binary>`, e.g. from `npm run host:build`.
const dist = process.env.HERDR_BOT_HOST_DIST;
test("installs the real built host and it runs", { skip: !haveTools || dist == null || !existsSync(join(dist, "manifest.json")), timeout: 120_000 }, async () => {
  const manifest = JSON.parse(readFileSync(join(dist, "manifest.json"), "utf8"));
  const asset = manifest.assets[key];
  await withInstall({ served: { "/manifest.json": readFileSync(join(dist, "manifest.json")), [`/${asset.file}`]: readFileSync(join(dist, asset.file)) } }, async ({ home, source }) => {
    const result = await installHost({ source, botHome: home, platform, arch: process.arch, fetchText: async (url) => (await fetch(url)).text(), exec: run });
    assert.equal(result.sha256, asset.sha256);
    // `dance` is not a command: a non-zero exit with this message proves the installed file is a working herdr-bot.
    const ran = await run(result.path, ["dance"]);
    assert.notEqual(ran.code, 0);
    assert.match(ran.stderr, /herdr-bot: unknown command "dance"/);
  });
});
