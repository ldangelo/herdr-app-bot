import { test } from "node:test";
import assert from "node:assert/strict";
import { applyEvent, statusOf, summarize, visibleChats } from "../herdr-bot/state.js";

const bot = (id, status, extra = {}) => ({ id, kind: "bot", name: id, isRunning: false, isHiddenFromSidebar: false, lastActivityAt: 0, awaitingUserResponse: null, bot: { status }, ...extra });
const room = (id, isRunning, extra = {}) => ({ id, kind: "room", name: id, isRunning, isHiddenFromSidebar: false, lastActivityAt: 0, awaitingUserResponse: null, bot: null, ...extra });

test("statusOf speaks herdr's words", () => {
  assert.equal(statusOf(bot("a", "working")), "working");
  assert.equal(statusOf(bot("a", "idle")), "idle");
  assert.equal(statusOf(bot("a", "offline")), "offline");
  assert.equal(statusOf(bot("a", "weird")), "unknown");
  assert.equal(statusOf({ kind: "bot", bot: null }), "unknown");
  assert.equal(statusOf(bot("a", "working", { awaitingUserResponse: { reason: "approval" } })), "blocked");
  assert.equal(statusOf(bot("a", "idle", { awaitingUserResponse: { reason: "offline" } })), "idle", "only an approval is 'needs you'");
  assert.equal(statusOf(room("r", true)), "working");
  assert.equal(statusOf(room("r", false)), "idle");
});

test("needs-you first, then working, then newest; hidden chats are dropped", () => {
  const chats = [
    bot("quiet", "idle", { lastActivityAt: 50 }),
    bot("busy", "working", { lastActivityAt: 10 }),
    bot("stuck", "idle", { awaitingUserResponse: { reason: "approval" }, lastActivityAt: 1 }),
    bot("recent", "idle", { lastActivityAt: 90 }),
    bot("gone", "idle", { isHiddenFromSidebar: true, lastActivityAt: 999 }),
    bot("away", "offline", { lastActivityAt: 100 }),
  ];
  assert.deepEqual(visibleChats(chats).map((chat) => chat.id), ["stuck", "busy", "recent", "quiet", "away"]);
});

test("ties fall back to the name", () => {
  assert.deepEqual(visibleChats([bot("b", "idle"), bot("a", "idle")]).map((chat) => chat.id), ["a", "b"]);
});

test("applyEvent replaces the list, upserts one chat, and ignores the rest", () => {
  const a = bot("a", "idle");
  const b = bot("b", "idle");
  assert.deepEqual(applyEvent([a], { type: "chat.listChanged", payload: [b] }), [b]);
  const updated = bot("a", "working");
  assert.deepEqual(applyEvent([a, b], { type: "chat.changed", payload: updated }), [updated, b]);
  assert.deepEqual(applyEvent([a], { type: "chat.changed", payload: b }), [a, b], "a new chat is appended");
  const same = [a];
  assert.equal(applyEvent(same, { type: "transcript.entryAppended", payload: {} }), same);
  assert.equal(applyEvent(same, undefined), same);
  assert.equal(applyEvent(same, { type: "chat.changed", payload: null }), same);
});

test("applyEvent does not mutate its input", () => {
  const list = [bot("a", "idle")];
  applyEvent(list, { type: "chat.changed", payload: bot("a", "working") });
  assert.equal(list[0].bot.status, "idle");
});

test("summarize counts what needs attention, ignoring hidden chats", () => {
  const chats = [bot("a", "working"), bot("b", "working"), bot("c", "idle", { awaitingUserResponse: { reason: "approval" } }), bot("d", "working", { isHiddenFromSidebar: true }), room("r", true)];
  assert.deepEqual(summarize(chats), { blocked: 1, working: 3 });
});
