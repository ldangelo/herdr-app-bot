import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import WebSocket from "ws";
import { readWsEndpoint } from "../src/ws/server.ts";
import { createExecHcRunner } from "../src/herdr/hc-cli.ts";
import { makeTempHome } from "./helpers/temp-home.ts";
import { waitFor } from "./helpers/wait-for.ts";

/**
 * The compiled standalone host, on the hc runtime, against a real herdr-core: the whole path a herdr-app mod uses.
 * Opt-in (it starts terminals):
 *
 *   HERDR_BOT_HC_INTEGRATION=1 HERDR_BOT_HC_BIN=<wrapper around hc on a disposable core> \
 *   HERDR_BOT_HOST_BIN=<dist/host/herdr-bot-...> npm test
 */
const hcBin = process.env.HERDR_BOT_HC_BIN;
const hostBin = process.env.HERDR_BOT_HOST_BIN;
const enabled = process.env.HERDR_BOT_HC_INTEGRATION === "1" && hcBin != null && hcBin.length > 0 && hostBin != null && hostBin.length > 0;

function fakeAgent(home: string, cliCommand: string): string {
  return `#!/bin/bash
export HERDR_BOT_HOME='${home}'
e=$'\\033'
st() { printf "\${e}]7501;state=%s:app=fake\${e}\\\\" "$1"; }
handle() {
  if [[ "$1" =~ say\\ ([a-z][a-z0-9_-]*)\\ \\" ]]; then
    ${cliCommand} say "\${BASH_REMATCH[1]}" "hi from $HC_TERMINAL_ID" > /dev/null 2>&1
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

test("standalone host on hc: serve, create a bot over the socket, hear it answer, get pushed events, delete it", { skip: !enabled, timeout: 180_000 }, async () => {
  const temp = makeTempHome();
  const agent = join(temp.home, "fake-agent.sh");
  // The bot speaks through the same compiled binary a real bot would call.
  writeFileSync(agent, fakeAgent(temp.home, `'${resolve(hostBin!)}'`));
  chmodSync(agent, 0o755);
  const runner = createExecHcRunner(hcBin!);
  const child = spawn(hostBin!, ["serve", "--runtime", "hc", "--exit-when-idle", "20"], {
    env: { ...process.env, HERDR_BOT_HOME: temp.home, HERDR_BOT_HC_BIN: hcBin!, HERDR_BOT_USER_NAME: "ray", HERDR_BOT_HC_KIND_COMMANDS: JSON.stringify({ claude: [agent] }) },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let log = "";
  child.stderr.on("data", (chunk: Buffer) => { log += chunk.toString(); });
  const exited = new Promise<number | null>((done) => child.once("exit", (code) => done(code)));
  try {
    await waitFor(() => readWsEndpoint(temp.home) != null, { timeoutMs: 30_000, intervalMs: 100, message: `no endpoint\n${log}` });
    const endpoint = readWsEndpoint(temp.home)!;
    const socket = new WebSocket(`ws://127.0.0.1:${endpoint.port}/`);
    const replies = new Map<number, Record<string, unknown>>();
    const events: string[] = [];
    let counter = 0;
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString()) as { id?: number; op?: string; event?: { type: string } };
      if (typeof message.id === "number") replies.set(message.id, message as Record<string, unknown>);
      else if (message.op === "event" && message.event != null) events.push(message.event.type);
    });
    await new Promise<void>((open, fail) => { socket.once("open", () => open()); socket.once("error", fail); });
    socket.send(JSON.stringify({ op: "auth", token: endpoint.token }));
    const call = async (method: string, params: unknown): Promise<any> => {
      const id = ++counter;
      socket.send(JSON.stringify({ id, method, params }));
      await waitFor(() => replies.has(id), { timeoutMs: 60_000, intervalMs: 50, message: `${method} never answered\n${log}` });
      const reply = replies.get(id)!;
      if (reply.error != null) throw new Error(`${method}: ${JSON.stringify(reply.error)}`);
      return reply.result;
    };
    await waitFor(() => true);
    await new Promise((done) => setTimeout(done, 400)); // let the auth handshake settle

    const created = await call("bot.create", { name: "Bin", provider: "claude", model: "opus", reasoningEffort: "high", cwd: temp.home, permissionMode: "ask" });
    assert.equal(created.chat.id, "bin");
    await call("message.send", { chatId: "bin", text: "hello" });
    let lines: string[] = [];
    for (const deadline = Date.now() + 60_000; Date.now() < deadline;) {
      const page = await call("transcript.page", { chatId: "bin", limit: 20 });
      lines = page.entries.map((entry: { kind: string; content?: string; message?: { content?: string } }) => entry.content ?? entry.message?.content ?? "");
      if (lines.some((line: string) => /^hi from t[0-9a-z]+$/.test(line))) break;
      await new Promise((done) => setTimeout(done, 250));
    }
    assert.ok(lines.includes("hello"), JSON.stringify(lines));
    assert.ok(lines.some((line) => /^hi from t[0-9a-z]+$/.test(line)), `${JSON.stringify(lines)}\n${log}`);
    assert.ok(events.includes("transcript.entryAppended"), `pushed events: ${events.join(",")}`);
    assert.ok(events.includes("chat.changed"), `pushed events: ${events.join(",")}`);

    await call("chat.delete", { chatIds: ["bin"] });
    const left = JSON.parse((await runner(["ls", "--json", "--label", "herdr-bot=1"])).stdout) as { terminals: unknown[] };
    assert.equal(left.terminals.length, 0, "deleting the bot ends its terminal");

    socket.close();
    assert.equal(await exited, 0, log); // idle exit after the client leaves
  } finally {
    if (child.exitCode == null) child.kill("SIGKILL");
    const rest = JSON.parse((await runner(["ls", "--json", "--label", "herdr-bot=1"])).stdout) as { terminals: { address: string }[] };
    for (const terminal of rest.terminals) {
      await runner(["kill", terminal.address]);
      await runner(["rm", terminal.address]);
    }
    temp.cleanup();
  }
});
