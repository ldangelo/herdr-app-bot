import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createExecHcRunner, createHcCli, createHcEventSubscriber } from "../src/herdr/hc-cli.ts";
import { makeTempHome } from "./helpers/temp-home.ts";
import { waitFor } from "./helpers/wait-for.ts";

/** Like waitFor, for conditions that need a round-trip to hc to evaluate. */
async function waitForAsync(predicate: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() >= deadline) throw new Error(`waitForAsync: condition not met within ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/**
 * Runs the real `hc` runtime against a real herdr-core. Opt-in, because it starts terminals:
 *
 *   HERDR_BOT_HC_INTEGRATION=1 HERDR_BOT_HC_BIN=<wrapper> npm test
 *
 * <wrapper> must point `hc` at a disposable core, never your own: an executable that execs `hc "$@"` with
 * its own HC_SESSION and scratch XDG_*_HOME, and HC_TERMINAL_* unset (see `hc --skill`: "Tests need
 * their own HC_SESSION and scratch XDG paths").
 */
const hcBin = process.env.HERDR_BOT_HC_BIN;
const enabled = process.env.HERDR_BOT_HC_INTEGRATION === "1" && hcBin != null && hcBin.length > 0;

const FAKE_AGENT = `#!/bin/bash
e=$'\\033'
st() { printf "\${e}]7501;state=%s:app=fake\${e}\\\\" "$1"; }
st idle
echo "fake agent ready"
while IFS= read -r line; do
  st working
  case "$line" in
    *BLOCK*) st blocked; echo "Allow command? 1) yes 2) no"; read -rsn1 k; echo "got:$k";;
    *) sleep 1;;
  esac
  echo "echo: $line"
  st done
done
`;

test("hc runtime against a real core: start, prompt, block, answer, adopt, close", { skip: !enabled, timeout: 120_000 }, async () => {
  const temp = makeTempHome();
  const agent = join(temp.home, "fake-agent.sh");
  writeFileSync(agent, FAKE_AGENT);
  chmodSync(agent, 0o755);
  const bin = hcBin!;
  const cli = createHcCli(bin, process.env, { cliPath: join(temp.home, "bin", "herdr-bot") });
  const runner = createExecHcRunner(bin);
  const started: string[] = [];
  try {
    const [core] = await cli.sessionList();
    assert.equal(core?.running, true);

    // Events are hints for the status mirror: watch them while we drive a bot.
    const events: string[] = [];
    const subscription = createHcEventSubscriber(bin)("hc:events", [], { onEvent: (event) => events.push(event.event), onClose: () => {} });

    const location = await cli.workspaceCreate({ cwd: temp.home, label: "integration" });
    // `kind` is argv[0] here, so any executable can play the agent.
    const info = await cli.agentStart({ name: "itest", kind: agent, paneId: location.rootPaneId, agentArgs: [] });
    started.push(info.pane_id);
    assert.equal(info.name, "itest");
    assert.equal(info.agent_status, "idle");

    const done = await cli.agentPrompt({ target: "itest", text: "hello", wait: true, timeoutMs: 20_000 });
    assert.equal(done?.agent_status, "done");
    assert.match(await cli.agentRead("itest", 0), /echo: hello/);

    const blocked = await cli.agentPrompt({ target: "itest", text: "BLOCK me", wait: true, timeoutMs: 20_000 });
    assert.equal(blocked?.agent_status, "blocked");
    assert.equal((await cli.agentGet("itest")).agent_status, "blocked");
    // A blocked agent refuses ordinary prompts (hc: kind "blocked").
    await assert.rejects(cli.agentPrompt({ target: "itest", text: "nope", wait: false }), { code: "agent_blocked" });
    const screen = await cli.agentRead("itest", 0, "detection");
    assert.match(screen, /Allow command\?/);

    await cli.agentSendKeys("itest", ["1"]);
    await waitForAsync(async () => (await cli.agentGet("itest")).agent_status === "done");
    assert.match(await cli.agentRead("itest", 0), /got:1/);
    await cli.agentPrompt({ target: "itest", text: "type this", wait: true, timeoutMs: 20_000 });
    await waitFor(() => events.includes("status"), { timeoutMs: 5_000 });

    // Adoption: an agent that this runtime did not start shows up as adoptable, then becomes a bot by label.
    const other = JSON.parse((await runner(["run", "--bg", "--json", "--name", "walkin", "--cwd", temp.home, "--no-parent", "--outlive-parent", "--", agent])).stdout) as { address: string };
    started.push(other.address);
    await waitForAsync(async () => (await cli.agentList()).some((candidate) => candidate.name === "walkin" && candidate.agent_status === "idle"));
    await cli.agentRename(other.address, "scout");
    const listed = await cli.agentList();
    assert.ok(listed.some((candidate) => candidate.name === "scout" && candidate.pane_id === other.address));
    assert.ok(!listed.some((candidate) => candidate.name === "walkin"));
    assert.equal((await cli.agentGet("scout")).pane_id, other.address);
    await cli.agentRename("scout", null);
    assert.equal((await cli.agentList()).find((candidate) => candidate.pane_id === other.address)?.name, "walkin");

    subscription.close();
  } finally {
    for (const address of started) {
      await cli.paneClose(address).catch(() => undefined);
    }
    temp.cleanup();
  }
});
