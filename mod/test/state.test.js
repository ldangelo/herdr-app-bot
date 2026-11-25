import { test } from "node:test";
import assert from "node:assert/strict";
import { applyEvent, roleOf, statusOf, summarize, visibleChats } from "../herdr-bot/state.js";

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

test("summarize counts bots that need attention, ignoring hidden chats and rooms (their members are already counted)", () => {
  const chats = [bot("a", "working"), bot("b", "working"), bot("c", "idle", { awaitingUserResponse: { reason: "approval" } }), bot("d", "working", { isHiddenFromSidebar: true }), room("r", true, { memberIds: ["a", "c"] })];
  assert.deepEqual(summarize(chats), { blocked: 1, working: 2 });
});

test("a room is what its members are doing: needs you if any bot waits, working if any works or a turn runs", () => {
  const chats = [bot("a", "idle"), bot("b", "working"), bot("c", "idle", { awaitingUserResponse: { reason: "approval" } })];
  const byId = new Map(chats.map((chat) => [chat.id, chat]));
  assert.equal(statusOf(room("r1", false, { memberIds: ["a"] }), byId), "idle");
  assert.equal(statusOf(room("r2", false, { memberIds: ["a", "b"] }), byId), "working");
  assert.equal(statusOf(room("r3", false, { memberIds: ["a", "b", "c"] }), byId), "blocked", "a waiting bot outranks a working one");
  assert.equal(statusOf(room("r4", true, { memberIds: ["a"] }), byId), "working", "a running turn counts even when no member shows it yet");
  assert.equal(statusOf(room("r5", false, { memberIds: ["ghost"] }), byId), "idle", "a member that is gone changes nothing");
  assert.equal(statusOf(room("r6", false, { memberIds: ["b"] })), "idle", "without the chats there is nothing to look at");
});

test("visibleChats ranks a room by its members, so a room that needs you comes first", () => {
  const chats = [bot("quiet", "idle", { lastActivityAt: 90 }), bot("stuck", "idle", { awaitingUserResponse: { reason: "approval" }, isHiddenFromSidebar: true }), room("room-x", false, { memberIds: ["stuck", "quiet"], lastActivityAt: 1 })];
  assert.deepEqual(visibleChats(chats).map((chat) => chat.id), ["room-x", "quiet"]);
});

test("a bot's role is its trimmed title", () => {
  assert.equal(roleOf(bot("a", "idle", { title: "  Code reviewer " })), "Code reviewer");
  assert.equal(roleOf(bot("a", "idle")), "");
  assert.equal(roleOf({ kind: "bot" }), "");
});
