import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_ROOM_MEMBERS as HOST_MAX_ROOM_MEMBERS } from "../../core/src/rooms/constants.ts";
import { MAX_ROOM_MEMBERS, MIN_ROOM_MEMBERS, canSubmitRoom, commonDirectory, describeRoomError, eligibleBots, memberStatuses, mentionHint, roomChanged, roomCreateParams, toggleMember } from "../herdr-bot/rooms.js";

const bot = (id, status, extra = {}) => ({ id, kind: "bot", name: id[0].toUpperCase() + id.slice(1), title: "", isHiddenFromSidebar: false, awaitingUserResponse: null, bot: { status, onboarding: null, cwd: "/work/shop" }, ...extra });
const room = (id, memberIds, extra = {}) => ({ id, kind: "room", name: id, memberIds, isRunning: false, isHiddenFromSidebar: false, ...extra });
const byId = (chats) => new Map(chats.map((chat) => [chat.id, chat]));

test("the member limit is the host's", () => {
  assert.equal(MAX_ROOM_MEMBERS, HOST_MAX_ROOM_MEMBERS);
  assert.equal(MIN_ROOM_MEMBERS, 2);
});

test("only visible bots that finished setup can join a room", () => {
  const chats = [bot("a", "idle"), bot("hidden", "idle", { isHiddenFromSidebar: true }), bot("new", "idle", { bot: { status: "idle", onboarding: { stage: "briefing" } } }), bot("done", "idle", { bot: { status: "idle", onboarding: { stage: "ready" } } }), bot("failed", "idle", { bot: { status: "idle", onboarding: { stage: "failed" } } }), room("room-x", ["a"])];
  assert.deepEqual(eligibleBots(chats).map((chat) => chat.id), ["a", "done"]);
});

test("a room's members show their own bot's status and role, in member order, and a missing member is offline", () => {
  const chats = [bot("atlas", "working", { title: " Code reviewer " }), bot("scout", "idle"), bot("nova", "idle", { awaitingUserResponse: { reason: "approval" } })];
  const members = memberStatuses(room("room-x", ["nova", "atlas", "ghost", "scout"]), byId(chats));
  assert.deepEqual(members.map((m) => [m.id, m.name, m.role, m.status]), [["nova", "Nova", "", "blocked"], ["atlas", "Atlas", "Code reviewer", "working"], ["ghost", "ghost", "", "offline"], ["scout", "Scout", "", "idle"]]);
});

test("toggleMember adds up to the limit, removes, and never mutates", () => {
  const start = ["a"];
  assert.deepEqual(toggleMember(start, "b"), ["a", "b"]);
  assert.deepEqual(start, ["a"]);
  assert.deepEqual(toggleMember(["a", "b"], "a"), ["b"]);
  const full = ["a", "b", "c", "d", "e", "f"];
  assert.equal(toggleMember(full, "g"), full, "a seventh is refused");
  assert.deepEqual(toggleMember(full, "f"), ["a", "b", "c", "d", "e"], "but one can still be removed");
});

test("a room needs a name, 2 to 6 bots and a folder", () => {
  const ok = { name: "Review", selected: ["a", "b"], directory: "/work/shop" };
  assert.equal(canSubmitRoom(ok), true);
  assert.equal(canSubmitRoom({ ...ok, name: "  " }), false);
  assert.equal(canSubmitRoom({ ...ok, selected: ["a"] }), false, "one bot is just a DM");
  assert.equal(canSubmitRoom({ ...ok, selected: [] }), false);
  assert.equal(canSubmitRoom({ ...ok, selected: ["a", "b", "c", "d", "e", "f", "g"] }), false);
  assert.equal(canSubmitRoom({ ...ok, directory: "   " }), false, "a room's folder is required here");
});

test("roomCreateParams trims, copies the selection, and only confirms the home folder when asked", () => {
  const selected = ["a", "b"];
  const params = roomCreateParams({ name: " Review ", selected, directory: " /work/shop " });
  assert.deepEqual(params, { name: "Review", memberIds: ["a", "b"], directory: "/work/shop" });
  assert.notEqual(params.memberIds, selected);
  assert.equal(roomCreateParams({ name: "r", selected, directory: "/h", allowHomeCwd: true }).allowHomeCwd, true);
});

test("the suggested folder is the one every selected bot already works in", () => {
  const chats = [bot("a", "idle"), bot("b", "idle"), bot("c", "idle", { bot: { status: "idle", cwd: "/work/other" } }), bot("d", "idle", { bot: { status: "idle", cwd: "" } })];
  assert.equal(commonDirectory(chats, ["a", "b"]), "/work/shop");
  assert.equal(commonDirectory(chats, ["a", "c"]), "", "they differ: no guess");
  assert.equal(commonDirectory(chats, ["a", "d"]), "", "one has none");
  assert.equal(commonDirectory(chats, ["a", "ghost"]), "");
  assert.equal(commonDirectory(chats, []), "");
});

test("roomChanged compares members as a set and the name and folder as typed", () => {
  const existing = room("room-x", ["a", "b"], { name: "Review", directory: "/work/shop" });
  const same = { name: " Review ", selected: ["b", "a"], directory: "/work/shop" };
  assert.equal(roomChanged(existing, same), false);
  assert.equal(roomChanged(existing, { ...same, name: "Other" }), true);
  assert.equal(roomChanged(existing, { ...same, directory: "/elsewhere" }), true);
  assert.equal(roomChanged(existing, { ...same, selected: ["a"] }), true);
  assert.equal(roomChanged(room("room-y", ["a"], { name: "R" }), { name: "R", selected: ["a"], directory: "" }), false, "a room that never had a folder");
});

test("mentionHint and room errors", () => {
  assert.equal(mentionHint(["atlas", "scout"]), "@atlas @scout");
  assert.equal(mentionHint([]), "");
  assert.match(describeRoomError({ code: "too_many_members" }), /at most 6/);
  assert.match(describeRoomError({ code: "bot_not_ready" }), /still being set up/);
  assert.match(describeRoomError({ code: "invalid_directory", message: '"x" is not a folder that exists' }), /not usable: "x" is not a folder/);
  assert.match(describeRoomError({ code: "home_cwd_requires_confirmation" }), /home folder/);
  assert.equal(describeRoomError({ message: "plain" }), "plain");
  assert.equal(describeRoomError(undefined), "Something went wrong.");
});
