import { test } from "node:test";
import assert from "node:assert/strict";
import { connectToHost, hostLaunchArgs, isHostAlreadyStarting } from "../herdr-bot/host.js";

function clock() {
  let t = 0;
  return { now: () => t, sleep: async (ms) => { t += ms; } };
}

test("a running host is connected to straight away, without starting anything", async () => {
  const phases = [];
  let started = 0;
  const result = await connectToHost({
    ...clock(), readEndpoint: async () => ({ port: 1, token: "t" }), startHost: async () => { started += 1; },
    connect: async (endpoint) => ({ client: endpoint.port }), onPhase: (phase) => phases.push(phase),
  });
  assert.deepEqual(result, { client: 1 });
  assert.equal(started, 0);
  assert.deepEqual(phases, ["connecting"]);
});

test("no endpoint: the host is started once, then connected to when it appears", async () => {
  const phases = [];
  let started = 0;
  let reads = 0;
  const result = await connectToHost({
    ...clock(), readEndpoint: async () => (++reads < 4 ? null : { port: 9, token: "t" }), startHost: async () => { started += 1; },
    connect: async (endpoint) => ({ client: endpoint.port }), onPhase: (phase) => phases.push(phase),
  });
  assert.deepEqual(result, { client: 9 });
  assert.equal(started, 1);
  assert.deepEqual(phases, ["connecting", "starting"]);
});

test("a stale endpoint file (a crashed host) is treated like no host", async () => {
  let started = 0;
  let attempts = 0;
  const result = await connectToHost({
    ...clock(), readEndpoint: async () => ({ port: started === 0 ? 1 : 2, token: "t" }), startHost: async () => { started += 1; },
    connect: async (endpoint) => { attempts += 1; if (endpoint.port === 1) throw new Error("connection refused"); return { client: 2 }; },
  });
  assert.deepEqual(result, { client: 2 });
  assert.equal(started, 1);
  assert.equal(attempts, 2);
});

test("it gives up after the timeout and says why", async () => {
  await assert.rejects(
    connectToHost({ ...clock(), readEndpoint: async () => ({ port: 1, token: "t" }), startHost: async () => {}, connect: async () => { throw new Error("connection refused"); }, timeoutMs: 2000, pollMs: 500 }),
    /did not come up \(connection refused\)/,
  );
  await assert.rejects(
    connectToHost({ ...clock(), readEndpoint: async () => null, startHost: async () => {}, connect: async () => ({}), timeoutMs: 1000 }),
    /no endpoint published/,
  );
});

test("a failure to start the host is reported, not retried", async () => {
  let started = 0;
  await assert.rejects(connectToHost({ ...clock(), readEndpoint: async () => null, startHost: async () => { started += 1; throw new Error("no shim"); }, connect: async () => ({}) }), /no shim/);
  assert.equal(started, 1);
});

test("the launch command starts a parentless, self-stopping hc-runtime host", () => {
  const args = hostLaunchArgs({ botHome: "/home/me/.herdr-bot", shimPath: "/home/me/.herdr-bot/bin/herdr-bot" });
  assert.deepEqual(args.slice(0, 8), ["run", "--bg", "--json", "--name", "herdr-bot-host", "--no-parent", "--outlive-parent", "--no-notify"]);
  const command = args.slice(args.indexOf("--") + 1);
  assert.deepEqual(command, ["env", "HERDR_BOT_HOME=/home/me/.herdr-bot", "/home/me/.herdr-bot/bin/herdr-bot", "serve", "--runtime", "hc", "--exit-when-idle", "30"]);
  assert.equal(hostLaunchArgs({ botHome: "/h", shimPath: "/h/s", idleSeconds: 5 }).at(-1), "5");
});

test("hc's refusal of a taken name means a host is already starting", () => {
  // The real message, as printed by `hc run --name x` when x is live.
  const taken = '{"error":{"hint":"pick another name, or kill the one holding it","kind":"name_taken","message":"a live terminal is already named \\"herdr-bot-host\\""}}';
  assert.equal(isHostAlreadyStarting({ code: 1, stderr: taken, stdout: "" }), true);
  assert.equal(isHostAlreadyStarting({ code: 1, stderr: "", stdout: taken }), true);
  assert.equal(isHostAlreadyStarting({ code: 0, stderr: "", stdout: "{}" }), false);
  assert.equal(isHostAlreadyStarting({ code: 1, stderr: "hc: command not found", stdout: "" }), false);
  assert.equal(isHostAlreadyStarting({ code: 1, stderr: '{"error":{"kind":"invalid_params","message":"bad name"}}', stdout: "" }), false);
});
