import { test } from "node:test";
import assert from "node:assert/strict";
import { IdleExit } from "../src/ws/idle-exit.ts";

function harness(graceMs = 30_000) {
  const timers = new Map<number, { callback: () => void; ms: number }>();
  let next = 1;
  let idled = 0;
  const idle = new IdleExit({
    graceMs,
    onIdle: () => { idled += 1; },
    setTimer: (callback, ms) => { const id = next++; timers.set(id, { callback, ms }); return id; },
    clearTimer: (handle) => { timers.delete(handle as number); },
  });
  /** Like a real timer: it is gone by the time its callback runs. */
  const fire = (): void => { const first = [...timers.entries()][0]; if (first == null) return; timers.delete(first[0]); first[1].callback(); };
  return { idle, timers, fire, idled: () => idled };
}

test("a host nobody ever connects to goes idle after the grace period", () => {
  const h = harness(5_000);
  h.idle.start();
  assert.equal(h.timers.size, 1);
  assert.equal([...h.timers.values()][0]!.ms, 5_000);
  h.fire();
  assert.equal(h.idled(), 1);
});

test("a connected client keeps the host alive, and its leaving restarts the clock", () => {
  const h = harness();
  h.idle.start();
  h.idle.clients(1);
  assert.equal(h.timers.size, 0);
  h.idle.clients(2);
  h.idle.clients(1);
  assert.equal(h.timers.size, 0, "still someone there");
  h.idle.clients(0);
  assert.equal(h.timers.size, 1);
  h.fire();
  assert.equal(h.idled(), 1);
});

test("going idle fires once, and stop() cancels it for good", () => {
  const first = harness();
  first.idle.start();
  first.fire();
  first.idle.clients(0);
  first.idle.clients(1);
  first.idle.clients(0);
  assert.equal(first.timers.size, 0, "does not re-arm after it fired");
  assert.equal(first.idled(), 1);

  const second = harness();
  second.idle.start();
  second.idle.stop();
  assert.equal(second.timers.size, 0);
  second.idle.clients(0);
  assert.equal(second.timers.size, 0, "stopped means stopped");
  assert.equal(second.idled(), 0);
});

test("repeated zero reports do not stack timers", () => {
  const h = harness();
  h.idle.start();
  h.idle.clients(0);
  h.idle.clients(0);
  assert.equal(h.timers.size, 1);
});
