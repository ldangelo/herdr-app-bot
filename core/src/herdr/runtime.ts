import type { HostConfig } from "../config.ts";
import { createHerdrCli, type HerdrCli } from "./cli.ts";
import { ensureHerdrSession, spawnHerdrSessionServer } from "./session.ts";
import { createHcCli, createHcEventSubscriber } from "./hc-cli.ts";
import { subscribeHerdrEvents, type SubscribeEvents } from "./socket.ts";

export type { SubscribeEvents };

/** Which agent runtime the host drives: the terminal `herdr` (0.9+) or herdr-core's `hc` (herdr-app). */
export type RuntimeKind = "herdr" | "hc";

export const RUNTIME_KINDS: readonly RuntimeKind[] = ["herdr", "hc"];

/**
 * Everything the host needs from the thing that actually runs the agents. `cli` is the command
 * surface the services already use (`HerdrCli`), `subscribe` + `endpoint` are the live-change hint
 * (the mirror still polls `cli.agentList()` for truth), and `ensureSession` brings the backend up.
 */
export interface AgentRuntime {
  readonly kind: RuntimeKind;
  readonly cli: HerdrCli;
  readonly subscribe: SubscribeEvents;
  /** Opaque to the mirror: passed straight to `subscribe`. `null` means "no event channel, poll only". */
  readonly endpoint: string | null;
  /** `null` when the backend needs no start-up step. */
  readonly ensureSession: (() => Promise<string>) | null;
}

/** `cli` lets a caller (tests) substitute the command surface while keeping herdr's event channel and session start-up. */
export function createHerdrRuntime(config: HostConfig, env: NodeJS.ProcessEnv = process.env, cli: HerdrCli = createHerdrCli(config.herdrBin, env, config.herdrSession)): AgentRuntime {
  return {
    kind: "herdr",
    cli,
    subscribe: subscribeHerdrEvents,
    endpoint: config.herdrSocketPath,
    ensureSession: () => ensureHerdrSession({
      session: config.herdrSession,
      sessionList: () => cli.sessionList(),
      spawnServer: () => spawnHerdrSessionServer(config.herdrBin, config.herdrSession),
    }),
  };
}

/** herdr-core's `hc` (the runtime behind herdr-app). It needs no session of its own: `hc server status` starts the core. */
export function createHcRuntime(config: HostConfig, env: NodeJS.ProcessEnv = process.env, cli: HerdrCli = createHcCli(config.hcBin, env, { cliPath: config.cliPath })): AgentRuntime {
  return {
    kind: "hc",
    cli,
    subscribe: createHcEventSubscriber(config.hcBin, env),
    endpoint: "hc:events",
    ensureSession: async () => (await cli.sessionList())[0]?.socketPath ?? "hc",
  };
}

export function createAgentRuntime(config: HostConfig, env: NodeJS.ProcessEnv = process.env, cli?: HerdrCli): AgentRuntime {
  switch (config.runtime) {
    case "herdr":
      return createHerdrRuntime(config, env, cli);
    case "hc":
      return createHcRuntime(config, env, cli);
  }
}
