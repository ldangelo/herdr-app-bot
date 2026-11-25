import { test } from "node:test";
import assert from "node:assert/strict";
import { AppApiClient } from "../herdr-bot/client.js";

/** A socket the test drives: `push` queues what the server would send; reads wait for it. */
function fakeSocket() {
  const queue = [];
  const waiters = [];
  const sent = [];
  let closed = false;
  const socket = {
    sent,
    get closed() { return closed; },
    push(data) { const waiter = waiters.shift(); if (waiter) waiter.resolve(data); else queue.push(data); },
    end() { closed = true; for (const waiter of waiters.splice(0)) waiter.reject(new Error("closed")); },
    async read() {
      if (queue.length > 0) return queue.shift();
      if (closed) throw new Error("closed");
      return new Promise((resolve, reject) => waiters.push({ resolve, reject }));
    },
    async write(data) { if (closed) throw new Error("closed"); sent.push(JSON.parse(data)); },
    async close() { closed = true; },
  };
  return socket;
}

const never = () => new Promise(() => {});
const tick = () => new Promise((resolve) => setImmediate(resolve));

async function opened(overrides = {}) {
  const socket = fakeSocket();
  const events = [];
  const client = new AppApiClient({ connect: async (url) => { socket.url = url; return socket; }, sleep: never, onEvent: (event) => events.push(event), ...overrides });
  socket.push(JSON.stringify({ op: "ready" }));
  await client.open({ port: 4242, token: "tok" });
  return { client, socket, events };
}

test("open connects to the loopback port and authenticates first", async () => {
  const { client, socket } = await opened();
  assert.equal(socket.url, "ws://127.0.0.1:4242/");
  assert.deepEqual(socket.sent, [{ op: "auth", token: "tok" }]);
  assert.equal(client.isOpen, true);
});

test("open refuses a host that does not say ready, and closes the socket", async () => {
  const socket = fakeSocket();
  socket.push(JSON.stringify({ op: "nope" }));
  const client = new AppApiClient({ connect: async () => socket, sleep: never });
  await assert.rejects(client.open({ port: 1, token: "t" }), /did not accept/);
  assert.equal(socket.closed, true);
  assert.equal(client.isOpen, false);
});

test("open surfaces a close during auth (a wrong token)", async () => {
  const socket = fakeSocket();
  socket.end();
  const client = new AppApiClient({ connect: async () => socket, sleep: never });
  await assert.rejects(client.open({ port: 1, token: "t" }));
  assert.equal(client.isOpen, false);
});

test("requests are matched to responses by id, in any order", async () => {
  const { client, socket } = await opened();
  const pump = client.pump();
  const first = client.request("chat.list", { a: 1 });
  const second = client.request("host.status");
  await tick();
  assert.deepEqual(socket.sent.slice(1), [{ id: 1, method: "chat.list", params: { a: 1 } }, { id: 2, method: "host.status", params: {} }]);
  socket.push(JSON.stringify({ id: 2, result: "two" }));
  socket.push(JSON.stringify({ id: 1, result: "one" }));
  assert.equal(await first, "one");
  assert.equal(await second, "two");
  socket.end();
  await pump;
});

test("an API error rejects with its code", async () => {
  const { client, socket } = await opened();
  const pump = client.pump();
  const failing = client.request("bot.create");
  await tick();
  socket.push(JSON.stringify({ id: 1, error: { code: "bot_exists", message: "already there" } }));
  await assert.rejects(failing, (error) => error.code === "bot_exists" && /already there/.test(error.message));
  socket.end();
  await pump;
});

test("events reach onEvent, and garbage is ignored", async () => {
  const { client, socket, events } = await opened();
  const pump = client.pump();
  socket.push("not json");
  socket.push(new Uint8Array([1, 2]));
  socket.push(JSON.stringify({ op: "event", event: { seq: 1, type: "chat.changed", payload: { id: "a" } } }));
  socket.push(JSON.stringify({ id: 999, result: "nobody asked" }));
  socket.end();
  await pump;
  assert.deepEqual(events, [{ seq: 1, type: "chat.changed", payload: { id: "a" } }]);
});

test("a request that gets no answer times out and is forgotten", async () => {
  const timers = [];
  const { client, socket } = await opened({ sleep: (ms) => new Promise((resolve) => timers.push({ ms, resolve })), requestTimeoutMs: 5000 });
  const pump = client.pump();
  const slow = client.request("chat.list");
  await tick();
  assert.equal(timers.at(-1).ms, 5000);
  timers.at(-1).resolve();
  await assert.rejects(slow, /chat.list timed out/);
  assert.equal(client.pending.size, 0);
  socket.end();
  await pump;
});

test("when the connection ends, pending requests reject and the client is closed", async () => {
  const { client, socket } = await opened();
  const pump = client.pump();
  const waiting = client.request("chat.list");
  await tick();
  socket.end();
  await assert.rejects(waiting, /disconnected/);
  await pump;
  assert.equal(client.isOpen, false);
  await assert.rejects(client.request("chat.list"), /not connected/);
});

test("close() ends the connection and rejects what is pending", async () => {
  const { client, socket } = await opened();
  const waiting = client.request("chat.list");
  await tick();
  await client.close();
  await assert.rejects(waiting, /closed/);
  assert.equal(socket.closed, true);
  assert.equal(client.isOpen, false);
});
