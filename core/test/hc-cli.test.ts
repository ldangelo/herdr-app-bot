import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHcCliFromRunner, createHcEventSubscriber } from "../src/herdr/hc-cli.ts";
import { HerdrError } from "../src/herdr/types.ts";
import { FakeHc } from "./helpers/fake-hc.ts";
import { makeTempHome } from "./helpers/temp-home.ts";
import { waitFor } from "./helpers/wait-for.ts";

const noSleep = async (): Promise<void> => undefined;

function setup(options: Parameters<typeof createHcCliFromRunner>[1] = {}) {
  const hc = new FakeHc();
  const cli = createHcCliFromRunner(hc.runner, { cliDir: "/home/me/.herdr-bot/bin", sleep: noSleep, ...options });
  return { hc, cli };
}

async function startBot(cli: ReturnType<typeof setup>["cli"], name = "reviewer", kind = "claude", agentArgs: string[] = []) {
  const location = await cli.workspaceCreate({ cwd: "/work/shop", label: "herdr-bot: shop" });
  return cli.agentStart({ name, kind, paneId: location.rootPaneId, agentArgs });
}

async function assertCode(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => error instanceof HerdrError && error.code === code);
}

test("agentStart runs the agent as a labelled, parentless, kept terminal named after the bot", async () => {
  const { hc, cli } = setup();
  const info = await startBot(cli, "reviewer", "claude", ["--model", "opus"]);
  const run = hc.calls.find((call) => call[0] === "run")!;
  assert.deepEqual(run.slice(0, 8), ["run", "--bg", "--json", "--name", "reviewer", "--cwd", "/work/shop", "--label"]);
  for (const flag of ["herdr-bot=1", "herdr-bot.id=reviewer", "--no-parent", "--outlive-parent", "--keep", "--no-notify"]) assert.ok(run.includes(flag), flag);
  // The agent is exec'd by a tiny sh wrapper so the bot CLI folder lands on the terminal's own PATH.
  const launch = run.slice(run.indexOf("--") + 1);
  assert.deepEqual(launch.slice(0, 2), ["sh", "-c"]);
  assert.deepEqual(launch.slice(3), ["herdr-bot", "/home/me/.herdr-bot/bin", "claude", "--model", "opus"]);
  assert.equal(info.name, "reviewer");
  assert.equal(info.agent, "claude");
  assert.equal(info.agent_status, "idle");
  assert.equal(info.pane_id, hc.terminals[0]!.address);
});

test("codex is launched with --no-daemon", async () => {
  const { hc, cli } = setup();
  await startBot(cli, "coder", "codex");
  const run = hc.calls.find((call) => call[0] === "run")!;
  const launch = run.slice(run.indexOf("--") + 1);
  assert.deepEqual(launch.slice(-2), ["codex", "--no-daemon"]);
});

test("agentStart without a bot CLI folder runs the agent directly", async () => {
  const { hc, cli } = setup({ cliDir: null });
  await startBot(cli, "reviewer", "claude");
  const run = hc.calls.find((call) => call[0] === "run")!;
  assert.deepEqual(run.slice(run.indexOf("--") + 1), ["claude"]);
});

test("agentStart reports agent_not_ready when the program never reports a status", async () => {
  let clock = 0;
  const { hc, cli } = setup({ now: () => clock, sleep: async (ms) => { clock += ms; }, startTimeoutMs: 1_000 });
  hc.startStatus = null;
  await assertCode(startBot(cli), "agent_not_ready");
  assert.equal(hc.terminals.length, 1, "the terminal is left running for first-run setup");
});

test("agentStart rejects a pane that was never created, and a taken name surfaces hc's error", async () => {
  const { hc, cli } = setup();
  await assertCode(cli.agentStart({ name: "x", kind: "claude", paneId: "pending:99", agentArgs: [] }), "pane_not_found");
  hc.add({ name: "reviewer", status: { app: "claude-code", state: "idle" } });
  await assertCode(startBot(cli, "reviewer"), "hc_name_taken");
});

test("agentList returns managed bots by id and only adoptable agents that report a status", async () => {
  const { hc, cli } = setup();
  hc.add({ name: "reviewer", labels: { "herdr-bot": "1", "herdr-bot.id": "reviewer" }, status: { app: "claude-code", state: "working" } });
  hc.add({ name: "review", labels: { "herdr-bot": "1", "herdr-bot.id": "scout" }, status: { app: "codex", state: "blocked" } });
  hc.add({ name: "other", status: { app: "omp", state: "done" } });
  hc.add({ name: "shell" }); // a plain shell: never an agent
  hc.add({ name: "broken", status: { app: "omp", state: "error" } });
  const agents = await cli.agentList();
  const byName = new Map(agents.map((agent) => [agent.name, agent]));
  assert.deepEqual([...byName.keys()].sort(), ["broken", "other", "reviewer", "scout"]);
  assert.equal(byName.get("reviewer")!.agent, "claude");
  assert.equal(byName.get("reviewer")!.agent_status, "working");
  assert.equal(byName.get("scout")!.agent_status, "blocked", "adopted bot is named by its label, not its hc name");
  assert.equal(byName.get("other")!.agent_status, "done");
  assert.equal(byName.get("broken")!.agent_status, "unknown", "hc's error state has no herdr equivalent");
});

test("agentList reads each adopted terminal's labels once", async () => {
  const { hc, cli } = setup();
  hc.add({ name: "review", labels: { "herdr-bot": "1", "herdr-bot.id": "scout" }, status: { app: "codex", state: "idle" } });
  await cli.agentList();
  await cli.agentList();
  assert.equal(hc.calls.filter((call) => call[0] === "get").length, 1);
});

test("agentGet resolves a bot id through its label and an address directly; finished means not running", async () => {
  const { hc, cli } = setup();
  const adopted = hc.add({ name: "review", labels: { "herdr-bot": "1", "herdr-bot.id": "scout" }, status: { app: "codex", state: "idle" } });
  assert.equal((await cli.agentGet("scout")).pane_id, adopted.address);
  assert.equal((await cli.agentGet(adopted.address)).name, "scout");
  adopted.state = "finished";
  await assertCode(cli.agentGet("scout"), "agent_not_running");
  await assertCode(cli.agentGet("nobody"), "agent_not_running");
});

test("agentRename adopts by label and clears it again", async () => {
  const { hc, cli } = setup();
  const terminal = hc.add({ name: "review", status: { app: "codex", state: "idle" } });
  await cli.agentRename(terminal.address, "scout");
  assert.deepEqual(terminal.labels, { "herdr-bot": "1", "herdr-bot.id": "scout" });
  assert.equal((await cli.agentGet("scout")).name, "scout");
  await cli.agentRename("scout", null);
  assert.deepEqual(terminal.labels, {});
});

test("agentPrompt waits for the turn and reports the settled status", async () => {
  const { hc, cli } = setup();
  await startBot(cli);
  const done = await cli.agentPrompt({ target: "reviewer", text: "hi", wait: true, timeoutMs: 1_500 });
  assert.equal(done?.agent_status, "done");
  const send = hc.calls.filter((call) => call[0] === "send").at(-1)!;
  assert.deepEqual(send, ["send", "--json", "--wait", "--timeout", "2", hc.terminals[0]!.address, "hi"]);
  hc.sendOutcome = "blocked";
  hc.terminals[0]!.status = { app: "claude-code", state: "idle" };
  assert.equal((await cli.agentPrompt({ target: "reviewer", text: "again", wait: true }))?.agent_status, "blocked");
});

test("agentPrompt without wait just sends", async () => {
  const { hc, cli } = setup();
  await startBot(cli);
  assert.equal(await cli.agentPrompt({ target: "reviewer", text: "psst", wait: false }), null);
  assert.ok(!hc.calls.at(-1)!.includes("--wait"));
});

test("agentPrompt maps hc outcomes onto the error codes the turn runner switches on", async () => {
  const { hc, cli } = setup();
  await startBot(cli);
  hc.sendOutcome = "timeout";
  await assertCode(cli.agentPrompt({ target: "reviewer", text: "x", wait: true }), "timeout");
  hc.sendOutcome = "not_started";
  await assertCode(cli.agentPrompt({ target: "reviewer", text: "x", wait: true }), "agent_prompt_stalled");
  hc.sendOutcome = "exit";
  await assertCode(cli.agentPrompt({ target: "reviewer", text: "x", wait: true }), "agent_not_running");
  hc.sendOutcome = "done";
  hc.terminals[0]!.status = { app: "claude-code", state: "blocked" };
  await assertCode(cli.agentPrompt({ target: "reviewer", text: "x", wait: true }), "agent_blocked");
  hc.terminals[0]!.state = "finished";
  await assertCode(cli.agentPrompt({ target: "reviewer", text: "x", wait: true }), "agent_not_running");
});

test("keys, typed text and reads go to the resolved terminal", async () => {
  const { hc, cli } = setup();
  await startBot(cli);
  hc.terminals[0]!.screen = "Allow? 1) yes";
  await cli.agentSendKeys("reviewer", ["down", "enter"]);
  await cli.paneSendText(hc.terminals[0]!.address, "hi there");
  assert.deepEqual(hc.keys, [["down", "enter"], ["h", "i", "space", "t", "h", "e", "r", "e"]]);
  assert.equal(await cli.agentRead("reviewer", 40, "detection"), "Allow? 1) yes");
  assert.deepEqual(hc.calls.filter((call) => call[0] === "read").at(-1), ["read", hc.terminals[0]!.address, "--lines", "40"]);
  await cli.agentSendKeys("reviewer", []);
  assert.equal(hc.keys.length, 2, "no keys, no call");
});

test("paneClose forgets a pending pane without calling hc, and kills then removes a live one", async () => {
  const { hc, cli } = setup();
  const location = await cli.workspaceCreate({ cwd: "/work", label: "x" });
  await cli.paneClose(location.rootPaneId);
  assert.equal(hc.calls.length, 0);
  await assertCode(cli.agentStart({ name: "x", kind: "claude", paneId: location.rootPaneId, agentArgs: [] }), "pane_not_found");
  const info = await startBot(cli);
  await cli.paneClose(info.pane_id);
  assert.equal(hc.terminals.length, 0);
  assert.deepEqual(hc.calls.slice(-2).map((call) => call[0]), ["kill", "rm"]);
});

test("workspaces are virtual: none are ever live, so every bot gets a fresh pending pane", async () => {
  const { cli } = setup();
  assert.deepEqual(await cli.workspaceList(), []);
  const first = await cli.workspaceCreate({ cwd: "/a", label: "a" });
  const second = await cli.tabCreate({ workspaceId: first.workspaceId, cwd: "/a", label: "b" });
  assert.notEqual(first.rootPaneId, second.rootPaneId);
});

test("agentFocus calls herdr-app with the terminal address, and is unsupported without it", async () => {
  const calls: (readonly string[])[] = [];
  const { hc, cli } = setup({ runApp: async (args) => { calls.push(args); } });
  const terminal = hc.add({ name: "reviewer", labels: { "herdr-bot": "1", "herdr-bot.id": "reviewer" }, status: { app: "claude-code", state: "idle" } });
  await cli.agentFocus("reviewer");
  assert.deepEqual(calls, [["do", "agent.focus", JSON.stringify({ terminal: terminal.address })]]);
  await assertCode(setup().cli.agentFocus("reviewer"), "hc_unsupported");
});

test("sessionList reports the core as running (hc server status starts it)", async () => {
  const { cli } = setup();
  assert.deepEqual(await cli.sessionList(), [{ name: "hc", running: true, socketPath: "hc:core-1" }]);
});

test("event subscriber: handshake means ready, later events are hints, exit closes", async () => {
  const temp = makeTempHome();
  try {
    const script = join(temp.home, "fake-hc");
    writeFileSync(script, `#!/bin/sh\nprintf '%s\\n' '{"channel":null,"seq":0}'\nprintf '%s\\n' '{"jsonrpc":"2.0","method":"event","params":{"seq":1,"terminal":"t1","type":"status","data":{"status":{"state":"working"}}}}'\nsleep 0.3\n`);
    chmodSync(script, 0o755);
    const seen: string[] = [];
    let closed: Error | null | "open" = "open";
    createHcEventSubscriber(script)("hc:events", [{ type: "pane.updated" }], {
      onReady: () => seen.push("ready"),
      onEvent: (event) => seen.push(`${event.event}:${(event.data.status as { state: string }).state}`),
      onClose: (error) => { closed = error; },
    });
    await waitFor(() => closed !== "open");
    assert.deepEqual(seen, ["ready", "status:working"]);
    assert.equal(closed, null);
  } finally {
    temp.cleanup();
  }
});

test("event subscriber: a missing binary closes with an error and close() is idempotent", async () => {
  let errors = 0;
  const subscription = createHcEventSubscriber("/definitely/not/hc")("hc:events", [], { onEvent: () => {}, onClose: (error) => { if (error != null) errors += 1; } });
  await waitFor(() => errors === 1);
  subscription.close();
  assert.equal(errors, 1);
});
