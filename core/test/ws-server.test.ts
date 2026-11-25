import { test } from "node:test";
import assert from "node:assert/strict";
import { statSync } from "node:fs";
import WebSocket from "ws";
import { AppApiError } from "../src/app-api/errors.ts";
import type { AppApiServer } from "../src/app-api/server.ts";
import type { AppApiEvent } from "../src/app-api/types.ts";
import { readWsEndpoint, removeWsEndpoint, startAppApiWsServer, wsEndpointPath, writeWsEndpoint, type WsServer } from "../src/ws/server.ts";
import { makeTempHome } from "./helpers/temp-home.ts";
import { waitFor } from "./helpers/wait-for.ts";

function fakeApi() {
  const listeners = new Set<(event: AppApiEvent) => void>();
  const calls: { method: string; params: unknown }[] = [];
  const api: AppApiServer = {
    async call(method, params) {
      calls.push({ method, params });
      if (method === "boom") throw new Error("kaput");
      if (method === "denied") throw new AppApiError("unknown_bot", "nope");
      if (method === "nothing") return undefined;
      return { echoed: method, params };
    },
    subscribe(onEvent) {
      listeners.add(onEvent);
      return () => listeners.delete(onEvent);
    },
    close() {},
  };
  const emit = (event: AppApiEvent): void => listeners.forEach((listener) => listener(event));
  return { api, calls, emit, listenerCount: () => listeners.size };
}

const event = (seq: number): AppApiEvent => ({ seq, type: "chat.changed", payload: { id: "a" } }) as unknown as AppApiEvent;

class Client {
  readonly socket: WebSocket;
  readonly messages: Record<string, unknown>[] = [];
  closed: { code: number; reason: string } | null = null;

  constructor(server: WsServer, options?: ConstructorParameters<typeof WebSocket>[2]) {
    this.socket = new WebSocket(`ws://127.0.0.1:${server.port}/`, options);
    this.socket.on("message", (data) => this.messages.push(JSON.parse(data.toString()) as Record<string, unknown>));
    this.socket.on("close", (code, reason) => { this.closed = { code, reason: reason.toString() }; });
    this.socket.on("error", () => {});
  }

  opened(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket.once("open", () => resolve());
      this.socket.once("unexpected-response", (_request, response) => reject(new Error(`http ${response.statusCode}`)));
      this.socket.once("error", reject);
    });
  }

  send(value: unknown): void {
    this.socket.send(typeof value === "string" ? value : JSON.stringify(value));
  }

  async authenticate(server: WsServer): Promise<void> {
    await this.opened();
    this.send({ op: "auth", token: server.token });
    await waitFor(() => this.messages.some((message) => message.op === "ready"));
  }
}

async function withServer(run: (server: WsServer, fake: ReturnType<typeof fakeApi>) => Promise<void>, options: { authTimeoutMs?: number; maxMessageBytes?: number; onClientCount?: (count: number) => void } = {}): Promise<void> {
  const fake = fakeApi();
  const server = await startAppApiWsServer({ api: fake.api, ...options });
  try {
    await run(server, fake);
  } finally {
    await server.close();
  }
}

test("a client that authenticates can call methods and receives events", async () => {
  await withServer(async (server, fake) => {
    const client = new Client(server);
    await client.authenticate(server);
    client.send({ id: 1, method: "chat.list", params: { a: 1 } });
    client.send({ id: "two", method: "nothing" });
    await waitFor(() => client.messages.filter((message) => "id" in message).length === 2);
    assert.deepEqual(client.messages.find((message) => message.id === 1), { id: 1, result: { echoed: "chat.list", params: { a: 1 } } });
    assert.deepEqual(client.messages.find((message) => message.id === "two"), { id: "two", result: null });
    fake.emit(event(7));
    await waitFor(() => client.messages.some((message) => message.op === "event"));
    assert.deepEqual(client.messages.find((message) => message.op === "event"), { op: "event", event: event(7) });
    client.socket.close();
  });
});

test("nothing is delivered and no method runs before authenticating", async () => {
  await withServer(async (server, fake) => {
    const client = new Client(server);
    await client.opened();
    client.send({ id: 1, method: "chat.list" });
    await waitFor(() => client.closed != null);
    assert.equal(client.closed!.code, 4401);
    assert.equal(fake.calls.length, 0);
    fake.emit(event(1));
    assert.equal(client.messages.length, 0);
    assert.equal(fake.listenerCount(), 0, "an unauthenticated client never subscribes");
  });
});

test("a wrong token closes the connection", async () => {
  await withServer(async (server, fake) => {
    for (const token of ["nope", "", 12, null]) {
      const client = new Client(server);
      await client.opened();
      client.send({ op: "auth", token });
      await waitFor(() => client.closed != null);
      assert.equal(client.closed!.code, 4401, JSON.stringify(token));
    }
    assert.equal(fake.calls.length, 0);
  });
});

test("a client that never authenticates is closed after the deadline", async () => {
  await withServer(async (server) => {
    const client = new Client(server);
    await client.opened();
    await waitFor(() => client.closed != null, { timeoutMs: 3_000 });
    assert.deepEqual(client.closed, { code: 4401, reason: "auth timeout" });
  }, { authTimeoutMs: 100 });
});

test("a browser-style connection (with an Origin header) is refused", async () => {
  await withServer(async (server) => {
    const client = new Client(server, { origin: "https://evil.example" });
    await assert.rejects(client.opened(), /http 401/);
  });
});

test("errors reach the caller with their code, and unknown errors become internal", async () => {
  await withServer(async (server) => {
    const client = new Client(server);
    await client.authenticate(server);
    client.send({ id: 1, method: "denied" });
    client.send({ id: 2, method: "boom" });
    client.send({ method: "no-id" });
    await waitFor(() => client.messages.filter((message) => message.error != null).length === 3);
    assert.deepEqual(client.messages.find((message) => message.id === 1), { id: 1, error: { code: "unknown_bot", message: "nope" } });
    assert.deepEqual(client.messages.find((message) => message.id === 2), { id: 2, error: { code: "internal", message: "kaput" } });
    assert.equal((client.messages.find((message) => message.id === undefined && message.error != null)!.error as { code: string }).code, "invalid_request");
    assert.equal(client.closed, null, "a bad request does not drop the connection");
  });
});

test("malformed input closes the connection", async () => {
  await withServer(async (server) => {
    const text = new Client(server);
    await text.authenticate(server);
    text.send("{not json");
    await waitFor(() => text.closed != null);
    assert.equal(text.closed!.code, 1003);
    const binary = new Client(server);
    await binary.authenticate(server);
    binary.socket.send(Buffer.from([1, 2, 3]));
    await waitFor(() => binary.closed != null);
    assert.equal(binary.closed!.code, 1003);
  });
});

test("an oversized message is refused", async () => {
  await withServer(async (server, fake) => {
    const client = new Client(server);
    await client.authenticate(server);
    client.send({ id: 1, method: "chat.list", params: "x".repeat(5_000) });
    await waitFor(() => client.closed != null);
    assert.equal(client.closed!.code, 1009);
    assert.equal(fake.calls.length, 0);
  }, { maxMessageBytes: 1_000 });
});

test("the client count follows authenticated connections only, and a closed client stops receiving events", async () => {
  const counts: number[] = [];
  await withServer(async (server, fake) => {
    const idle = new Client(server);
    await idle.opened();
    assert.equal(server.clientCount(), 0);
    const client = new Client(server);
    await client.authenticate(server);
    assert.equal(server.clientCount(), 1);
    client.socket.close();
    await waitFor(() => server.clientCount() === 0);
    assert.deepEqual(counts, [1, 0]);
    assert.equal(fake.listenerCount(), 0, "the departed client is unsubscribed");
    idle.socket.close();
  }, { onClientCount: (count) => counts.push(count) });
});

test("close() drops every client", async () => {
  const fake = fakeApi();
  const server = await startAppApiWsServer({ api: fake.api });
  const client = new Client(server);
  await client.authenticate(server);
  await server.close();
  await waitFor(() => client.closed != null);
  assert.equal(fake.listenerCount(), 0);
});

test("plain HTTP gets a 404, not an API", async () => {
  await withServer(async (server) => {
    const response = await fetch(`http://127.0.0.1:${server.port}/`);
    assert.equal(response.status, 404);
  });
});

test("the endpoint file is private, atomic and only removed by its owner", () => {
  const temp = makeTempHome();
  try {
    assert.equal(readWsEndpoint(temp.home), null);
    writeWsEndpoint(temp.home, { port: 1234, token: "secret", pid: 99 });
    assert.deepEqual(readWsEndpoint(temp.home), { port: 1234, token: "secret", pid: 99 });
    assert.equal(statSync(wsEndpointPath(temp.home)).mode & 0o777, 0o600);
    removeWsEndpoint(temp.home, "someone-else");
    assert.notEqual(readWsEndpoint(temp.home), null, "a different host's token does not remove it");
    removeWsEndpoint(temp.home, "secret");
    assert.equal(readWsEndpoint(temp.home), null);
  } finally {
    temp.cleanup();
  }
});
