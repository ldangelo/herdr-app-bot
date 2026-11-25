import { test } from "node:test";
import assert from "node:assert/strict";
import { canEditLaunch, initialSettings, settingsChanged, settingsChanges, settingsProblem } from "../herdr-bot/settings.js";

const bot = (over = {}, facts = {}) => ({
  id: "pm", kind: "bot", name: "PM", title: "Product manager", description: "Writes PRDs.",
  bot: { provider: "pi", adopted: false, model: "litellm/slow", reasoningEffort: null, cwd: "/work", permissionMode: "ask", ...facts },
  ...over,
});

test("launch settings are editable for a started bot, not an adopted one or a room", () => {
  assert.equal(canEditLaunch(bot()), true);
  assert.equal(canEditLaunch(bot({}, { adopted: true })), false);
  assert.equal(canEditLaunch({ id: "r", kind: "room", name: "R" }), false);
  assert.equal(canEditLaunch(bot({}, { provider: "someday" })), false);
});

test("nothing changed means nothing to send", () => {
  const chat = bot();
  assert.deepEqual(settingsChanges(chat, initialSettings(chat)), { profile: null, launch: null });
  assert.equal(settingsChanged(chat, initialSettings(chat)), false);
});

test("only the changed fields are sent, split into profile and launch", () => {
  const chat = bot();
  const edit = { ...initialSettings(chat), name: " Priya ", role: "", model: "anthropic/claude-haiku-4-5", permissionMode: "auto" };
  assert.deepEqual(settingsChanges(chat, edit), {
    profile: { name: "Priya", title: "" },
    launch: { model: "anthropic/claude-haiku-4-5", permissionMode: "auto" },
  });
});

test("an optional model can be cleared back to the CLI's own", () => {
  const chat = bot();
  assert.deepEqual(settingsChanges(chat, { ...initialSettings(chat), model: null }).launch, { model: null });
});

test("reasoning is only sent for providers that take it, and the folder only when it changed", () => {
  const claude = bot({}, { provider: "claude", model: "opus", reasoningEffort: "high" });
  assert.deepEqual(settingsChanges(claude, { ...initialSettings(claude), reasoningEffort: "max", cwd: "/work" }).launch, { reasoningEffort: "max" });
  const pi = bot();
  assert.equal(settingsChanges(pi, { ...initialSettings(pi), reasoningEffort: "max" }).launch, null);
  assert.deepEqual(settingsChanges(pi, { ...initialSettings(pi), cwd: " /other ", allowHomeCwd: true }).launch, { cwd: "/other", allowHomeCwd: true });
});

test("an adopted bot only has its profile sent", () => {
  const chat = bot({}, { adopted: true });
  const edit = { ...initialSettings(chat), name: "Priya", model: "x", cwd: "/elsewhere", permissionMode: "auto" };
  assert.deepEqual(settingsChanges(chat, edit), { profile: { name: "Priya" }, launch: null });
});

test("problems: a name is required, a model where the provider needs one, and a folder", () => {
  const chat = bot();
  const base = initialSettings(chat);
  assert.equal(settingsProblem(chat, base), null);
  assert.equal(settingsProblem(chat, { ...base, name: "  " }), "A bot needs a name.");
  assert.equal(settingsProblem(chat, { ...base, cwd: "" }), "Choose a working folder.");
  assert.equal(settingsProblem(chat, { ...base, model: null }), null, "pi's model is optional");
  const opencode = bot({}, { provider: "opencode", model: "a/b" });
  assert.equal(settingsProblem(opencode, { ...initialSettings(opencode), model: null }), "Pick a model.");
});
