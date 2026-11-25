import { execFile, spawn } from "node:child_process";
import { dirname } from "node:path";
import type { HerdrCli, HerdrReadSource, RawHerdrRunner } from "./cli.ts";
import type { HerdrSubscription, SubscribeEvents } from "./socket.ts";
import { ndjsonSplitter } from "./socket.ts";
import { HerdrError, type HerdrAgentInfo, type HerdrAgentStatus } from "./types.ts";

/**
 * `HerdrCli` over herdr-core's `hc` (the runtime behind herdr-app). Differences from the terminal herdr
 * this hides from the services:
 *
 * - hc has no workspaces/tabs/panes to create first, so `workspaceCreate`/`tabCreate` hand out a virtual
 *   "pending" pane id that `agentStart` turns into a real `hc run`.
 * - A bot is identified by the label `herdr-bot.id=<botId>` (and `herdr-bot=1` marks every managed
 *   terminal). Terminals this runtime starts are also named `<botId>` (bot ids are valid hc names);
 *   adopted terminals keep whatever name they have, so the label is the only reliable identity.
 * - Status words come from the program's OSC 7501 reports; hc's `error` has no herdr equivalent and maps
 *   to "unknown" (a person has to look at the screen).
 */

export const MANAGED_LABEL = "herdr-bot";
export const ID_LABEL = "herdr-bot.id";
const PENDING_PREFIX = "pending:";
const DEFAULT_START_TIMEOUT_MS = 30_000;
const START_POLL_MS = 250;

/** What to run for a provider kind, when it is not just the kind's own name. */
const KIND_COMMANDS: Readonly<Record<string, readonly string[]>> = {
  // Codex needs --no-daemon or its commands run outside hc (hc manual).
  codex: ["codex", "--no-daemon"],
  cursor: ["cursor-agent"],
};

/** hc reports the agent's own app name; herdr-bot's profiles use the short provider kind. */
const APP_TO_KIND: Readonly<Record<string, string>> = { "claude-code": "claude" };

export interface HcCliOptions {
  /** Folder holding the `herdr-bot` CLI; prepended to PATH inside every bot terminal (hc terminals get the login PATH, not the host's). */
  readonly cliDir?: string | null;
  /** `herdr-app` binary used for `agentFocus`; absent = focusing is unsupported. */
  readonly runApp?: ((args: readonly string[]) => Promise<void>) | null;
  readonly startTimeoutMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** hc prints `{error:{kind,message,hint}}` on stderr (or stdout with --json); map its kinds onto the codes the services switch on. */
function errorFrom(parsed: unknown, fallback: string): HerdrError | null {
  if (!isRecord(parsed) || !isRecord(parsed.error)) return null;
  const kind = str(parsed.error.kind) ?? "error";
  const message = str(parsed.error.message) ?? fallback;
  const code = kind === "blocked" ? "agent_blocked"
    : kind === "finished" || kind === "not_found" ? "agent_not_running"
    : kind === "status_mismatch" ? "agent_busy"
    : `hc_${kind}`;
  return new HerdrError(code, message, parsed);
}

function errorFromOutput(stdout: string, stderr: string, fallback: string): HerdrError {
  for (const text of [stderr, stdout]) {
    for (const line of text.split("\n")) {
      if (!line.startsWith("{")) continue;
      const error = errorFrom(parseJson(line), fallback);
      if (error != null) return error;
    }
  }
  return new HerdrError("hc_error", stderr.trim().length > 0 ? stderr.trim() : fallback);
}

function mapState(state: unknown): HerdrAgentStatus {
  return state === "idle" || state === "working" || state === "blocked" || state === "done" ? state : "unknown";
}

/** `ls` carries status as a bare word, `get` and events as `{app,state}`. */
function stateWord(status: unknown): unknown {
  return isRecord(status) ? status.state : status;
}

function appWord(entry: Record<string, unknown>): string | null {
  const reported = isRecord(entry.status) ? str(entry.status.app) : null;
  const foreground = isRecord(entry.foreground) ? str(entry.foreground.name) : null;
  const app = reported ?? str(entry.agent) ?? foreground;
  return app == null ? null : APP_TO_KIND[app] ?? app;
}

function infoFrom(entry: Record<string, unknown>, name: string | null): HerdrAgentInfo | null {
  const address = str(entry.address);
  if (address == null) return null;
  return { name, agent: appWord(entry), agent_status: mapState(stateWord(entry.status)), pane_id: address, tab_id: null, workspace_id: null, cwd: str(entry.cwd), agent_session: null };
}

export function createExecHcRunner(binPath: string, env: NodeJS.ProcessEnv = process.env): RawHerdrRunner {
  return (args, options) => new Promise((resolve, reject) => {
    execFile(binPath, [...args], { env, maxBuffer: 16 * 1024 * 1024, encoding: "utf8", ...(options?.timeoutMs == null ? {} : { timeout: options.timeoutMs }) }, (error, stdout, stderr) => {
      if (error == null) return resolve({ stdout, stderr, code: 0 });
      const failure = error as NodeJS.ErrnoException & { killed?: boolean };
      if (failure.code === "ENOENT") return reject(new HerdrError("hc_spawn_failed", `cannot run hc binary at ${binPath}`));
      if (failure.killed === true) return reject(new HerdrError("hc_timeout", `hc ${args.join(" ")} timed out`));
      resolve({ stdout, stderr, code: typeof failure.code === "number" ? failure.code : 1 });
    });
  });
}

export function createHcCliFromRunner(runner: RawHerdrRunner, options: HcCliOptions = {}): HerdrCli {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  const pending = new Map<string, { cwd: string; label: string }>();
  let pendingCounter = 0;
  /** address -> bot id for terminals whose name is not their id (adopted ones). Labels never change behind our back. */
  const idByAddress = new Map<string, string | null>();

  async function run(args: readonly string[], timeoutMs?: number): Promise<{ stdout: string; stderr: string }> {
    const { stdout, stderr, code } = await runner(args, timeoutMs == null ? undefined : { timeoutMs });
    if (code !== 0) throw errorFromOutput(stdout, stderr, `hc ${args.join(" ")} exited with ${code}`);
    return { stdout, stderr };
  }

  async function runJson(args: readonly string[], timeoutMs?: number): Promise<Record<string, unknown>> {
    const { stdout } = await run(args, timeoutMs);
    const parsed = parseJson(stdout);
    const error = errorFrom(parsed, `hc ${args.join(" ")} failed`);
    if (error != null) throw error;
    if (!isRecord(parsed)) throw new HerdrError("hc_bad_json", `hc ${args.slice(0, 2).join(" ")} returned non-JSON output: ${stdout.slice(0, 200)}`);
    return parsed;
  }

  async function list(labels: readonly string[] = []): Promise<Record<string, unknown>[]> {
    const result = await runJson(["ls", "--json", ...labels.flatMap((label) => ["--label", label])], 10_000);
    return Array.isArray(result.terminals) ? result.terminals.filter(isRecord) : [];
  }

  /** A bot id resolves to the terminal labelled with it; anything else is passed through (an address or a name). */
  async function resolve(target: string): Promise<string> {
    if (target.startsWith(PENDING_PREFIX)) throw new HerdrError("pane_not_found", `${target} has not been started`);
    const labelled = await list([`${ID_LABEL}=${target}`]);
    const address = labelled.length === 1 ? str(labelled[0]!.address) : null;
    return address ?? target;
  }

  async function idFor(entry: Record<string, unknown>): Promise<string | null> {
    const address = str(entry.address);
    if (address == null) return null;
    if (!idByAddress.has(address)) {
      try {
        const got = await runJson(["get", address, "--json"], 10_000);
        const labels = isRecord(got.labels) ? got.labels : {};
        idByAddress.set(address, str(labels[ID_LABEL]));
      } catch {
        return str(entry.name); // leave uncached; the next refresh tries again
      }
    }
    return idByAddress.get(address) ?? str(entry.name);
  }

  async function infoForAddress(address: string): Promise<HerdrAgentInfo> {
    const got = await runJson(["get", address, "--json"], 10_000);
    if (got.state === "finished") throw new HerdrError("agent_not_running", `${address} has finished`);
    const labels = isRecord(got.labels) ? got.labels : {};
    const id = str(labels[ID_LABEL]);
    idByAddress.set(address, id);
    const info = infoFrom(got, id ?? str(got.name));
    if (info == null) throw new HerdrError("hc_bad_json", `hc get ${address} returned no address`);
    return info;
  }

  function newPending(cwd: string, label: string): string {
    const id = `${PENDING_PREFIX}${++pendingCounter}`;
    pending.set(id, { cwd, label });
    return id;
  }

  function kindArgv(kind: string): readonly string[] {
    return KIND_COMMANDS[kind] ?? [kind];
  }

  async function waitReady(address: string, timeoutMs: number): Promise<HerdrAgentInfo> {
    const deadline = now() + timeoutMs;
    for (;;) {
      const info = await infoForAddress(address);
      if (info.agent_status !== "unknown" && info.agent_status !== "working") return info;
      if (now() >= deadline) throw new HerdrError("agent_not_ready", `${address} did not report ready within ${timeoutMs}ms`, { address });
      await sleep(START_POLL_MS);
    }
  }

  return {
    async sessionList() {
      // `hc server status` also starts the core when it is not running, which is exactly what start-up wants.
      const status = await runJson(["server", "status", "--json"], 15_000);
      const core = isRecord(status.core) ? str(status.core.id) : null;
      return [{ name: "hc", running: true, socketPath: `hc:${core ?? "core"}` }];
    },

    async agentList() {
      const [all, managed] = await Promise.all([list(), list([`${MANAGED_LABEL}=1`])]);
      const managedAddresses = new Set(managed.map((entry) => str(entry.address)));
      const infos: HerdrAgentInfo[] = [];
      for (const entry of managed) {
        const info = infoFrom(entry, await idFor(entry));
        if (info != null) infos.push(info);
      }
      for (const entry of all) {
        // Adoptable agents: anything that reports a status and is not already one of ours.
        if (managedAddresses.has(str(entry.address)) || stateWord(entry.status) == null) continue;
        const info = infoFrom(entry, str(entry.name));
        if (info != null) infos.push(info);
      }
      return infos;
    },

    async agentGet(target) {
      return infoForAddress(await resolve(target));
    },

    async agentStart(args) {
      const location = pending.get(args.paneId);
      if (location == null) throw new HerdrError("pane_not_found", `no pending pane ${args.paneId}`);
      const dir = options.cliDir ?? null;
      // Runs in the terminal's own (login) environment, so $PATH there is expanded by sh, not by us.
      const launch = dir == null
        ? [...kindArgv(args.kind), ...args.agentArgs]
        : ["sh", "-c", 'dir=$1; shift; PATH="$dir:$PATH"; export PATH; exec "$@"', "herdr-bot", dir, ...kindArgv(args.kind), ...args.agentArgs];
      const started = await runJson([
        "run", "--bg", "--json", "--name", args.name, "--cwd", location.cwd,
        "--label", `${MANAGED_LABEL}=1`, "--label", `${ID_LABEL}=${args.name}`,
        "--no-parent", "--outlive-parent", "--keep", "--no-notify", "--", ...launch,
      ], 30_000);
      const address = str(started.address);
      if (address == null) throw new HerdrError("hc_bad_json", "hc run returned no address");
      pending.delete(args.paneId);
      idByAddress.set(address, args.name);
      return waitReady(address, args.timeoutMs ?? options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS);
    },

    async agentPrompt(args) {
      const address = await resolve(args.target);
      const seconds = args.timeoutMs == null ? [] : ["--timeout", String(Math.max(1, Math.ceil(args.timeoutMs / 1000)))];
      // Long-running when waiting: no process-level timeout, hc's own --timeout bounds it.
      const result = await runJson(["send", "--json", ...(args.wait ? ["--wait"] : []), ...seconds, address, args.text]);
      if (!args.wait) return null;
      if (result.started === false) throw new HerdrError("agent_prompt_stalled", `${args.target} did not start the turn`, result);
      const wait = isRecord(result.wait) ? result.wait : {};
      if (wait.ended === false) throw new HerdrError("timeout", `${args.target} did not finish within the timeout`, result);
      if (wait.reason === "exit" || wait.exit_code != null) throw new HerdrError("agent_not_running", `${args.target} exited`, result);
      const info = await infoForAddress(address);
      return { ...info, agent_status: mapState(wait.status ?? stateWord(info.agent_status)) };
    },

    async agentRename(target, name) {
      const address = await resolve(target);
      await run(name == null ? ["label", address, `${MANAGED_LABEL}=`, `${ID_LABEL}=`] : ["label", address, `${MANAGED_LABEL}=1`, `${ID_LABEL}=${name}`], 10_000);
      idByAddress.delete(address);
    },

    async agentFocus(target) {
      const runApp = options.runApp;
      if (runApp == null) throw new HerdrError("hc_unsupported", "focusing an agent needs the herdr-app command");
      await runApp(["do", "agent.focus", JSON.stringify({ terminal: await resolve(target) })]);
    },

    async agentRead(target, lines, _source?: HerdrReadSource) {
      const { stdout } = await run(["read", await resolve(target), "--lines", String(lines)], 10_000);
      return stdout;
    },

    async agentSendKeys(target, keys) {
      if (keys.length === 0) return;
      await run(["keys", await resolve(target), ...keys], 10_000);
    },

    async paneSendText(paneId, text) {
      if (text.length === 0) return;
      await run(["keys", await resolve(paneId), ...[...text].map((character) => character === " " ? "space" : character)], 10_000);
    },

    async workspaceList() {
      return [];
    },

    async workspaceCreate(args) {
      return { workspaceId: `hc:${args.cwd}`, rootPaneId: newPending(args.cwd, args.label) };
    },

    async tabCreate(args) {
      return { tabId: `hc:${args.label}`, rootPaneId: newPending(args.cwd, args.label) };
    },

    async paneClose(paneId) {
      if (pending.delete(paneId)) return;
      const address = await resolve(paneId);
      try {
        await run(["kill", address], 10_000);
      } finally {
        // A finished terminal lingers in `ls --all` until removed; ignore "already gone".
        await run(["rm", address], 10_000).catch(() => undefined);
        idByAddress.delete(address);
      }
    },

    async notify() {
      // herdr-app already raises its own attention toasts for blocked/done agents.
    },
  };
}

export function createHcCli(binPath: string, env: NodeJS.ProcessEnv = process.env, config: { readonly cliPath: string; readonly appBin?: string }): HerdrCli {
  const appBin = config.appBin ?? "herdr-app";
  return createHcCliFromRunner(createExecHcRunner(binPath, env), {
    cliDir: dirname(config.cliPath),
    runApp: (args) => new Promise((resolve, reject) => {
      execFile(appBin, [...args], { env, timeout: 10_000 }, (error) => (error == null ? resolve() : reject(new HerdrError("hc_app_failed", error.message))));
    }),
  });
}

/**
 * Live-change hints from `hc events --json --label herdr-bot=1`: the first line is a handshake, every later
 * `event` notification is only a nudge to refresh (the mirror re-reads `agentList()` for truth), so the
 * herdr-style per-pane `subscriptions` are ignored.
 */
export function createHcEventSubscriber(binPath: string, env: NodeJS.ProcessEnv = process.env): SubscribeEvents {
  return (_endpoint, _subscriptions, handlers): HerdrSubscription => {
    const child = spawn(binPath, ["events", "--json", "--label", `${MANAGED_LABEL}=1`], { env, stdio: ["ignore", "pipe", "ignore"] });
    let ready = false;
    let notified = false;
    let lastError: Error | null = null;
    const finish = (error: Error | null): void => {
      if (notified) return;
      notified = true;
      child.kill();
      handlers.onClose(error);
    };
    child.stdout.on("data", ndjsonSplitter((line) => {
      const message = parseJson(line);
      if (!isRecord(message)) return;
      if (!ready) {
        ready = true;
        handlers.onReady?.();
        return;
      }
      if (message.method === "event" && isRecord(message.params)) {
        const params = message.params;
        handlers.onEvent({ event: str(params.type) ?? "event", data: isRecord(params.data) ? params.data : {} });
      }
    }));
    child.on("error", (error) => {
      lastError = error;
    });
    child.on("close", () => finish(lastError));
    return { close: () => finish(null) };
  };
}
