import type { RawHerdrRunner } from "../../src/herdr/cli.ts";

export interface FakeHcTerminal {
  address: string;
  name: string | null;
  labels: Record<string, string>;
  /** `null` = the program never reported a status. */
  status: { app: string; state: string } | null;
  state: "live" | "finished";
  cwd: string;
  argv: string[];
  screen: string;
}

export type SendOutcome = "done" | "blocked" | "timeout" | "not_started" | "exit";

/**
 * An in-memory `hc`, behaving like the real one as observed in a scratch core (see the phase-0 notes):
 * `ls` has no labels and a bare status word, `get` has both, errors are `{error:{kind,message,hint}}`.
 */
export class FakeHc {
  readonly terminals: FakeHcTerminal[] = [];
  readonly calls: string[][] = [];
  readonly keys: string[][] = [];
  /** What a new `hc run` terminal reports once started; `null` simulates a program that never reports. */
  startStatus: { app: string; state: string } | null = { app: "claude-code", state: "idle" };
  sendOutcome: SendOutcome = "done";
  #counter = 0;

  add(partial: Partial<FakeHcTerminal> & { address?: string }): FakeHcTerminal {
    const terminal: FakeHcTerminal = {
      address: partial.address ?? `t${++this.#counter}`, name: null, labels: {}, status: null, state: "live", cwd: "/work", argv: [], screen: "", ...partial,
    };
    this.terminals.push(terminal);
    return terminal;
  }

  readonly runner: RawHerdrRunner = async (args) => {
    this.calls.push([...args]);
    const [command, ...rest] = args;
    switch (command) {
      case "ls": return this.#ls(rest);
      case "get": return this.#get(rest);
      case "run": return this.#run(rest);
      case "send": return this.#send(rest);
      case "keys": this.keys.push(rest.slice(1)); return this.#ok({ status: "idle", turn: 0 });
      case "read": return { stdout: this.#find(rest[0] ?? "")?.screen ?? "", stderr: "", code: 0 };
      case "label": return this.#label(rest);
      case "kill": { const found = this.#find(rest[0] ?? ""); if (found != null) found.state = "finished"; return this.#ok({}); }
      case "rm": { const index = this.terminals.findIndex((terminal) => terminal.address === rest[0]); if (index >= 0) this.terminals.splice(index, 1); return this.#ok({}); }
      case "server": return this.#ok({ core: { id: "core-1", name: "fake" }, live: this.terminals.length });
      default: return this.#fail("not_found", `fake hc has no ${String(command)}`);
    }
  };

  #ok(value: unknown) {
    return { stdout: `${JSON.stringify(value)}\n`, stderr: "", code: 0 };
  }

  #fail(kind: string, message: string) {
    return { stdout: "", stderr: `${JSON.stringify({ error: { kind, message, hint: "" } })}\n`, code: 1 };
  }

  #find(target: string): FakeHcTerminal | undefined {
    return this.terminals.find((terminal) => terminal.address === target || terminal.name === target);
  }

  #ls(rest: readonly string[]) {
    const wanted: [string, string][] = [];
    for (let index = 0; index < rest.length; index += 1) {
      if (rest[index] === "--label") {
        const [key, ...value] = (rest[index + 1] ?? "").split("=");
        wanted.push([key ?? "", value.join("=")]);
      }
    }
    const terminals = this.terminals
      .filter((terminal) => terminal.state === "live" && wanted.every(([key, value]) => terminal.labels[key] === value))
      .map((terminal) => ({ address: terminal.address, agent: terminal.status?.app ?? "sh", cwd: terminal.cwd, ...(terminal.name == null ? {} : { name: terminal.name }), state: terminal.state, ...(terminal.status == null ? {} : { status: terminal.status.state }), turn: 0 }));
    return this.#ok({ terminals });
  }

  #get(rest: readonly string[]) {
    const terminal = this.#find(rest[0] ?? "");
    if (terminal == null) return this.#fail("not_found", `no terminal ${rest[0] ?? ""}`);
    return this.#ok({ address: terminal.address, name: terminal.name, labels: terminal.labels, cwd: terminal.cwd, state: terminal.state, status: terminal.status, foreground: { name: "bash" }, turn: 0 });
  }

  #run(rest: readonly string[]) {
    const separator = rest.indexOf("--");
    const flags = separator < 0 ? rest : rest.slice(0, separator);
    const labels: Record<string, string> = {};
    let name: string | null = null;
    let cwd = "/work";
    for (let index = 0; index < flags.length; index += 1) {
      if (flags[index] === "--name") name = flags[index + 1] ?? null;
      if (flags[index] === "--cwd") cwd = flags[index + 1] ?? cwd;
      if (flags[index] === "--label") {
        const [key, ...value] = (flags[index + 1] ?? "").split("=");
        labels[key ?? ""] = value.join("=");
      }
    }
    if (name != null && this.terminals.some((terminal) => terminal.state === "live" && terminal.name === name)) return this.#fail("name_taken", `${name} is taken`);
    const terminal = this.add({ name, labels, cwd, status: this.startStatus, argv: separator < 0 ? [] : rest.slice(separator + 1) });
    return this.#ok({ address: terminal.address, agent: terminal.argv[0] ?? "sh", cwd, name, state: "live", turn: 0 });
  }

  #send(rest: readonly string[]) {
    const wait = rest.includes("--wait");
    const positional = rest.filter((value, index) => !value.startsWith("--") && rest[index - 1] !== "--timeout");
    const terminal = this.#find(positional[0] ?? "");
    if (terminal == null) return this.#fail("not_found", `no terminal ${positional[0] ?? ""}`);
    if (terminal.state === "finished") return this.#fail("finished", `${terminal.address} has finished`);
    if (terminal.status?.state === "blocked") return this.#fail("blocked", `${terminal.address} is blocked (waiting)`);
    if (!wait) return this.#ok({ started: true, status: "idle", turn: 0 });
    if (this.sendOutcome === "not_started") return this.#ok({ started: false, status: "idle", turn: 0, wait: { ended: false, reason: "not_started" } });
    if (this.sendOutcome === "timeout") return this.#ok({ started: true, status: "done", turn: 1, wait: { ended: false, reason: "timeout", status: "working", terminal: terminal.address, turn: 1 } });
    if (this.sendOutcome === "exit") return this.#ok({ started: true, status: "idle", turn: 1, wait: { ended: true, reason: "exit", exit_code: 0, status: null, terminal: terminal.address, turn: 1 } });
    const state = this.sendOutcome;
    if (terminal.status != null) terminal.status = { ...terminal.status, state };
    return this.#ok({ started: true, status: "idle", turn: 0, wait: { ended: true, exit_code: null, reason: "status", status: state, terminal: terminal.address, turn: 1 } });
  }

  #label(rest: readonly string[]) {
    const terminal = this.#find(rest[0] ?? "");
    if (terminal == null) return this.#fail("not_found", `no terminal ${rest[0] ?? ""}`);
    for (const pair of rest.slice(1)) {
      const [key, ...value] = pair.split("=");
      if (value.join("=").length === 0) delete terminal.labels[key ?? ""];
      else terminal.labels[key ?? ""] = value.join("=");
    }
    return this.#ok({ address: terminal.address, labels: terminal.labels });
  }
}
