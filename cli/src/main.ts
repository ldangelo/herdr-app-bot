#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { resolveConfig } from "../../core/src/config.ts";
import { controlRequest } from "../../core/src/control/client.ts";
import { ControlError } from "../../core/src/control/protocol.ts";
import { createAppApiServer } from "../../core/src/app-api/server.ts";
import { createHost } from "../../core/src/host.ts";
import { log } from "../../core/src/log.ts";
import { HOST_VERSION } from "../../core/src/version.ts";
import { IdleExit } from "../../core/src/ws/idle-exit.ts";
import { removeWsEndpoint, startAppApiWsServer, writeWsEndpoint } from "../../core/src/ws/server.ts";
import { parseCliArgs, type CliCommand } from "./args.ts";
import { isStandaloneBinary } from "./standalone.ts";
import { installShim, installStandaloneShim } from "./shim.ts";

/** Makes `<home>/bin/herdr-bot` work for the bots: a script that runs node on this file, or, for a compiled binary, itself. */
function ensureShim(home: string): string {
  if (!isStandaloneBinary(import.meta.url)) return installShim(home, process.execPath, fileURLToPath(import.meta.url));
  try {
    return installStandaloneShim(home, process.execPath);
  } catch (error) {
    // Something else already sits at <home>/bin/herdr-bot: leave it alone and carry on serving.
    log("cli", error instanceof Error ? error.message : String(error));
    return `${home}/bin/herdr-bot`;
  }
}

function printTranscript(result: unknown): void {
  const entries = (result as { entries?: { author: string; text: string; timestampMs: number }[] }).entries ?? [];
  for (const entry of entries) {
    const time = new Date(entry.timestampMs).toISOString().slice(11, 16);
    process.stdout.write(`[${time}] ${entry.author}: ${entry.text}\n`);
  }
}

/** Spawning or adopting a bot waits on `herdr agent start` (30 s) plus the identity brief (60 s). */
const LONG_RUNNING_METHODS = new Set(["bot.create", "bot.adopt"]);
const DEFAULT_TIMEOUT_MS = 10_000;
const LONG_RUNNING_TIMEOUT_MS = 120_000;

async function runControl(command: Extract<CliCommand, { kind: "control" }>): Promise<void> {
  const config = resolveConfig();
  const timeoutMs = LONG_RUNNING_METHODS.has(command.method) ? LONG_RUNNING_TIMEOUT_MS : DEFAULT_TIMEOUT_MS;
  const result = await controlRequest(config.controlSocketPath, command.method, command.params, timeoutMs);
  if (command.output === "transcript") printTranscript(result);
  else process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

async function serve(options: { readonly ws: boolean; readonly exitWhenIdleSeconds: number | null; readonly runtime: string | null }): Promise<void> {
  const config = resolveConfig(options.runtime == null ? process.env : { ...process.env, HERDR_BOT_RUNTIME: options.runtime });
  const host = createHost(config);
  await host.start();
  ensureShim(config.home);

  let api: ReturnType<typeof createAppApiServer> | null = null;
  let ws: Awaited<ReturnType<typeof startAppApiWsServer>> | null = null;
  let idle: IdleExit | null = null;
  const finished = new Promise<void>((resolve) => {
    let stopping = false;
    const stop = (): void => {
      if (stopping) return;
      stopping = true;
      idle?.stop();
      void (async () => {
        if (ws != null) { removeWsEndpoint(config.home, ws.token); await ws.close(); }
        api?.close();
        await host.stop();
        resolve();
      })();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    if (options.ws) {
      const graceMs = (options.exitWhenIdleSeconds ?? 0) * 1000;
      if (options.exitWhenIdleSeconds != null) idle = new IdleExit({ graceMs, onIdle: () => { log("cli", `no herdr-app client for ${options.exitWhenIdleSeconds}s; stopping`); stop(); } });
      api = createAppApiServer(host);
      void startAppApiWsServer({ api, version: HOST_VERSION, onClientCount: (count) => idle?.clients(count) }).then((server) => {
        ws = server;
        writeWsEndpoint(config.home, { port: server.port, token: server.token, pid: process.pid });
        log("cli", `app API on ws://127.0.0.1:${server.port} (endpoint in ${config.home}/ws.json)`);
        idle?.start();
      }, (error: unknown) => { log("cli", "could not start the app API socket", error instanceof Error ? error.message : String(error)); stop(); });
    }
  });
  log("cli", `herdr-bot host is serving (home ${config.home}). Press Ctrl+C to stop.`);
  await finished;
}

async function main(): Promise<void> {
  const parsed = parseCliArgs(process.argv.slice(2));
  if ("error" in parsed) {
    process.stderr.write(`herdr-bot: ${parsed.error}\n`);
    process.exit(2);
  }
  if (parsed.kind === "serve") return serve(parsed);
  if (parsed.kind === "install-shim") {
    const path = ensureShim(resolveConfig().home);
    process.stdout.write(`${path}\n`);
    return;
  }
  await runControl(parsed);
}

main().catch((error: unknown) => {
  if (error instanceof ControlError) {
    process.stderr.write(`herdr-bot: ${error.code}: ${error.message}\n`);
    if (error.code === "connect_failed") process.stderr.write("herdr-bot: is the host running? start it with `herdr-bot serve` or open the herdr-bot app.\n");
  } else {
    process.stderr.write(`herdr-bot: ${error instanceof Error ? error.message : String(error)}\n`);
  }
  process.exit(1);
});
