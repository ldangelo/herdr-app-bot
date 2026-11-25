import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHost } from "../src/host.ts";
import { resolveConfig } from "../src/config.ts";
import { createHcCli, createExecHcRunner } from "../src/herdr/hc-cli.ts";
import { createHcRuntime } from "../src/herdr/runtime.ts";
import { controlRequest } from "../src/control/client.ts";
import { makeTempHome } from "./helpers/temp-home.ts";

/**
 * The whole host on the hc runtime, against a real herdr-core, with a fake agent that answers through the
 * real `herdr-bot say` CLI. Opt-in (it starts terminals); see hc-cli.integration.test.ts for the setup:
 *
 *   HERDR_BOT_HC_INTEGRATION=1 HERDR_BOT_HC_BIN=<wrapper around hc on a disposable core> npm test
 */
const hcBin = process.env.HERDR_BOT_HC_BIN;
const enabled = process.env.HERDR_BOT_HC_INTEGRATION === "1" && hcBin != null && hcBin.length > 0;

function fakeAgentScript(home: string): string {
  const cli = resolve(import.meta.dirname, "../../cli/src/main.ts");
  return `#!/bin/bash
export HERDR_BOT_HOME='${home}'
e=$'\\033'
st() { printf "\${e}]7501;state=%s:app=fake\${e}\\\\" "$1"; }
handle() {
  if [[ "$1" =~ say\\ ([a-z][a-z0-9_-]*)\\ \\" ]]; then
    chat="\${BASH_REMATCH[1]}"
    '${process.execPath}' '${cli}' say "$chat" "hi from $HC_TERMINAL_ID" > /dev/null 2>&1
  fi
}
st idle
while true; do
  if IFS= read -r line; then
    st working
    handle "$line"
    while IFS= read -r -t 1 more; do handle "$more"; done
    st done
  fi
done
`;
}

test("host on the hc runtime: create a bot, run a turn, hear it say back, delete it", { skip: !enabled, timeout: 180_000 }, async () => {
  const temp = makeTempHome();
  const agent = join(temp.home, "fake-agent.sh");
  writeFileSync(agent, fakeAgentScript(temp.home));
  chmodSync(agent, 0o755);
  const bin = hcBin!;
  const config = resolveConfig({ HERDR_BOT_HOME: temp.home, HERDR_BOT_RUNTIME: "hc", HERDR_BOT_HC_BIN: bin, HERDR_BOT_USER_NAME: "ray", HERDR_BOT_DEFAULT_CWD: temp.home });
  assert.equal(config.runtime, "hc");
  const cli = createHcCli(bin, process.env, { cliPath: config.cliPath, kindCommands: { claude: [agent] } });
  const host = createHost(config, { runtime: createHcRuntime(config, process.env, cli) });
  await host.start();
  const sock = config.controlSocketPath;
  const runner = createExecHcRunner(bin);
  try {
    await controlRequest(sock, "bot.create", { id: "itest", name: "Itest", kind: "claude", model: "opus", reasoningEffort: "high" });
    const sent = (await controlRequest(sock, "send", { chatId: "itest", text: "hello" })) as { entryId: string };
    assert.ok(sent.entryId);
    let lines: string[] = [];
    for (const deadline = Date.now() + 60_000; Date.now() < deadline;) {
      const read = (await controlRequest(sock, "read", { chatId: "itest" })) as { entries: { author: string; text: string }[] };
      lines = read.entries.map((entry) => `${entry.author}: ${entry.text}`);
      if (lines.some((line) => line.startsWith("Itest: hi from t"))) break;
      await new Promise((resolveTimer) => setTimeout(resolveTimer, 250));
    }
    assert.ok(lines.includes("ray: hello"), JSON.stringify(lines));
    assert.ok(lines.some((line) => /^Itest: hi from t[0-9a-z]+$/.test(line)), JSON.stringify(lines));

    const runtime = host.mirror.get("itest");
    assert.notEqual(runtime.status, "offline");
    assert.match(runtime.paneId ?? "", /^t[0-9a-z]+$/);

    // `whoami` resolves the caller by the terminal address, exactly what HC_TERMINAL_ID carries.
    const who = (await controlRequest(sock, "whoami", { paneId: runtime.paneId })) as { bot: { id: string } };
    assert.equal(who.bot.id, "itest");

    await controlRequest(sock, "bot.delete", { id: "itest" });
    const live = JSON.parse((await runner(["ls", "--json", "--label", "herdr-bot=1"])).stdout) as { terminals: unknown[] };
    assert.equal(live.terminals.length, 0, "deleting the bot ends its terminal");
  } finally {
    await host.stop();
    const left = JSON.parse((await runner(["ls", "--json", "--label", "herdr-bot=1"])).stdout) as { terminals: { address: string }[] };
    for (const terminal of left.terminals) {
      await runner(["kill", terminal.address]);
      await runner(["rm", terminal.address]);
    }
    temp.cleanup();
  }
});
