import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import WebSocket from "ws";
import { readWsEndpoint, wsEndpointPath } from "../src/ws/server.ts";
import { installFakeHerdr } from "./helpers/fake-herdr-state.ts";
import { makeTempHome } from "./helpers/temp-home.ts";
import { waitFor } from "./helpers/wait-for.ts";

const MAIN = resolve(import.meta.dirname, "../../cli/src/main.ts");

test("serve --exit-when-idle: publishes its endpoint, serves the app API, and stops itself when the client leaves", { timeout: 60_000 }, async () => {
  const temp = makeTempHome();
  const fake = installFakeHerdr(temp.home, { agents: [], workspaces: [] });
  const child = spawn(process.execPath, [MAIN, "serve", "--exit-when-idle", "1"], {
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
  const child = spawn(process.execPath, [MAIN, "serve", "--exit-when-idle", "1"], {
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
