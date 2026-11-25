import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import WebSocket from "ws";
import { readWsEndpoint, wsEndpointPath } from "../src/ws/server.ts";
import { installFakeHerdr } from "./helpers/fake-herdr-state.ts";
import { makeTempHome } from "./helpers/temp-home.ts";
import { waitFor } from "./helpers/wait-for.ts";

const MAIN = resolve(import.meta.dirname, "../../cli/src/main.ts");

/** `HERDR_BOT_HOST_BIN` runs these same tests against the compiled standalone binary instead of `node main.ts`. */
const HOST_BIN = process.env.HERDR_BOT_HOST_BIN;
const launch = (args: string[]): [string, string[]] => (HOST_BIN == null ? [process.execPath, [MAIN, ...args]] : [HOST_BIN, args]);

test("serve --exit-when-idle: publishes its endpoint, serves the app API, and stops itself when the client leaves", { timeout: 60_000 }, async () => {
  const temp = makeTempHome();
  const fake = installFakeHerdr(temp.home, { agents: [], workspaces: [] });
  const child = spawn(...launch(["serve", "--exit-when-idle", "1"]), {
    env: { ...process.env, HERDR_BOT_HOME: temp.home, HERDR_BIN_PATH: fake.binPath, ...fake.env, HERDR_BOT_USER_NAME: "ray" },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let log = "";
  child.stderr.on("data", (chunk: Buffer) => { log += chunk.toString(); });
  const exited = new Promise<number | null>((done) => child.once("exit", (code) => done(code)));
  try {
    await waitFor(() => readWsEndpoint(temp.home) != null, { timeoutMs: 20_000, intervalMs: 50, message: `host never published its endpoint\n${log}` });
    const endpoint = readWsEndpoint(temp.home)!;
    assert.equal(endpoint.pid, child.pid);

    const socket = new WebSocket(`ws://127.0.0.1:${endpoint.port}/`);
    const received: Record<string, unknown>[] = [];
    socket.on("message", (data) => received.push(JSON.parse(data.toString()) as Record<string, unknown>));
    await new Promise<void>((open, fail) => { socket.once("open", () => open()); socket.once("error", fail); });
    socket.send(JSON.stringify({ op: "auth", token: endpoint.token }));
    await waitFor(() => received.some((message) => message.op === "ready"), { timeoutMs: 5_000 });
    socket.send(JSON.stringify({ id: 1, method: "host.status", params: {} }));
    socket.send(JSON.stringify({ id: 2, method: "chat.list", params: {} }));
    await waitFor(() => received.filter((message) => "id" in message).length === 2, { timeoutMs: 5_000 });
    assert.equal(received.find((message) => message.id === 1)?.error, undefined);
    assert.ok(Array.isArray((received.find((message) => message.id === 2) as { result: unknown }).result) || typeof (received.find((message) => message.id === 2) as { result: unknown }).result === "object");

    // While a client is connected the host outlives the 1 s grace period.
    await new Promise((done) => setTimeout(done, 1_500));
    assert.equal(child.exitCode, null, "a connected client keeps the host alive");

    socket.close();
    assert.equal(await exited, 0, log);
    assert.equal(existsSync(wsEndpointPath(temp.home)), false, "the endpoint file is removed on the way out");
  } finally {
    if (child.exitCode == null) child.kill("SIGKILL");
    temp.cleanup();
  }
});

test("serve --exit-when-idle with nobody ever connecting exits after the grace period", { timeout: 60_000 }, async () => {
  const temp = makeTempHome();
  const fake = installFakeHerdr(temp.home, { agents: [], workspaces: [] });
  const child = spawn(...launch(["serve", "--exit-when-idle", "1"]), {
    env: { ...process.env, HERDR_BOT_HOME: temp.home, HERDR_BIN_PATH: fake.binPath, ...fake.env },
    stdio: ["ignore", "ignore", "ignore"],
  });
  const exited = new Promise<number | null>((done) => child.once("exit", (code) => done(code)));
  try {
    assert.equal(await exited, 0);
    assert.equal(existsSync(wsEndpointPath(temp.home)), false);
  } finally {
    if (child.exitCode == null) child.kill("SIGKILL");
    temp.cleanup();
  }
});

const standalone = { skip: HOST_BIN == null ? "set HERDR_BOT_HOST_BIN to a compiled host binary" : false, timeout: 60_000 } as const;

test("standalone binary installed at <home>/bin/herdr-bot stays a binary, never overwritten by a shim", standalone, async () => {
  const temp = makeTempHome();
  const fake = installFakeHerdr(temp.home, { agents: [], workspaces: [] });
  const installed = join(temp.home, "bin", "herdr-bot");
  mkdirSync(join(temp.home, "bin"), { recursive: true });
  copyFileSync(HOST_BIN!, installed);
  chmodSync(installed, 0o755);
  const size = statSync(installed).size;
  const child = spawn(installed, ["serve", "--exit-when-idle", "1"], { env: { ...process.env, HERDR_BOT_HOME: temp.home, HERDR_BIN_PATH: fake.binPath, ...fake.env }, stdio: ["ignore", "ignore", "ignore"] });
  const exited = new Promise<number | null>((done) => child.once("exit", (code) => done(code)));
  try {
    assert.equal(await exited, 0);
    assert.equal(statSync(installed).size, size, "the binary is untouched");
    assert.equal(readFileSync(installed).subarray(0, 2).toString(), HOST_BIN == null ? "" : readFileSync(HOST_BIN).subarray(0, 2).toString());
    assert.notEqual(readFileSync(installed).subarray(0, 2).toString(), "#!", "not replaced by a shell script");
  } finally {
    if (child.exitCode == null) child.kill("SIGKILL");
    temp.cleanup();
  }
});

test("standalone binary run from elsewhere installs a shim that runs it, with the home set", standalone, async () => {
  const temp = makeTempHome();
  const fake = installFakeHerdr(temp.home, { agents: [], workspaces: [] });
  const child = spawn(HOST_BIN!, ["serve", "--exit-when-idle", "1"], { env: { ...process.env, HERDR_BOT_HOME: temp.home, HERDR_BIN_PATH: fake.binPath, ...fake.env }, stdio: ["ignore", "ignore", "ignore"] });
  const exited = new Promise<number | null>((done) => child.once("exit", (code) => done(code)));
  try {
    assert.equal(await exited, 0);
    const shim = readFileSync(join(temp.home, "bin", "herdr-bot"), "utf8");
    assert.match(shim, /^#!\/bin\/sh\n/);
    assert.ok(shim.includes(`exec '${HOST_BIN}' "$@"`), shim);
    assert.ok(shim.includes(`HERDR_BOT_HOME='${temp.home}'`), shim);
  } finally {
    if (child.exitCode == null) child.kill("SIGKILL");
    temp.cleanup();
  }
});
