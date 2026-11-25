import { test } from "node:test";
import assert from "node:assert/strict";
import { PROVIDERS as RENDERER_PROVIDERS } from "../../renderer/src/features/dialogs/provider-catalog.ts";
import { missingLaunchChoices } from "../../core/src/bots/launch-args.ts";
import { DEFAULT_REASONING, PROVIDERS, adoptParams, canCreate, createParams, describeError, initialForm, missingChoices, providerById, withProvider } from "../herdr-bot/form.js";

test("the mod offers exactly the renderer's providers, with the same launch capabilities", () => {
  assert.deepEqual(PROVIDERS, RENDERER_PROVIDERS.map(({ id, label, supportsModel, supportsReasoning }) => ({ id, label, supportsModel, supportsReasoning })));
});

test("missingChoices agrees with the host's missingLaunchChoices for every provider and combination", () => {
  for (const provider of [...PROVIDERS.map((p) => p.id), "unknown-kind", ""]) {
    for (const model of [null, "", "  ", "opus"]) {
      for (const reasoningEffort of [null, "high"]) {
        const form = { provider, model, reasoningEffort };
        const host = missingLaunchChoices({ kind: provider, model, reasoningEffort });
        assert.deepEqual(missingChoices(form), host, JSON.stringify(form));
      }
    }
  }
});

test("a fresh form follows the host's defaults and preselects a reasoning level only where it applies", () => {
  const form = initialForm({ cwd: "/work/shop", provider: "codex", permissionMode: "auto" });
  assert.deepEqual(form, { provider: "codex", model: null, reasoningEffort: DEFAULT_REASONING, name: "", cwd: "/work/shop", permissionMode: "auto", allowHomeCwd: false });
  assert.equal(initialForm({ provider: "agy" }).reasoningEffort, null);
  assert.equal(initialForm({ provider: "not-offered" }).provider, "claude", "a provider the picker does not offer falls back");
  assert.equal(initialForm({}).permissionMode, "ask");
  assert.equal(initialForm({}).cwd, "");
});

test("switching provider clears the model and keeps or drops the reasoning level to fit", () => {
  const form = { ...initialForm({ provider: "claude" }), model: "opus", reasoningEffort: "max" };
  const codex = withProvider(form, "codex");
  assert.deepEqual([codex.provider, codex.model, codex.reasoningEffort], ["codex", null, "max"]);
  const agy = withProvider(form, "agy");
  assert.deepEqual([agy.provider, agy.model, agy.reasoningEffort], ["agy", null, null]);
  assert.equal(withProvider(agy, "grok").reasoningEffort, DEFAULT_REASONING, "coming back to a provider with reasoning restores the default");
  assert.equal(withProvider(form, "claude"), form, "choosing the current provider changes nothing");
  assert.equal(withProvider(form, "nope"), form);
});

test("canCreate needs a name, a folder, and the launch choices", () => {
  const ready = { ...initialForm({ cwd: "/work", provider: "claude" }), name: "Scout", model: "opus" };
  assert.equal(canCreate(ready), true);
  assert.equal(canCreate({ ...ready, name: "   " }), false);
  assert.equal(canCreate({ ...ready, cwd: " " }), false);
  assert.equal(canCreate({ ...ready, model: null }), false);
  assert.equal(canCreate({ ...ready, reasoningEffort: null }), false);
  assert.equal(canCreate({ ...ready, provider: "unknown-kind" }), false, "only an offered provider");
});

test("createParams sends only what the provider accepts, trimmed", () => {
  const claude = { ...initialForm({ cwd: "/work", provider: "claude" }), name: "  Scout ", cwd: " /work ", model: "opus", reasoningEffort: "high" };
  assert.deepEqual(createParams(claude), { name: "Scout", provider: "claude", cwd: "/work", permissionMode: "ask", model: "opus", reasoningEffort: "high" });
  const agy = { ...initialForm({ cwd: "/work", provider: "agy" }), name: "Gem", model: "gemini-4-argon-high", reasoningEffort: "high" };
  const params = createParams(agy);
  assert.equal("reasoningEffort" in params, false, "agy has no separate reasoning choice");
  assert.equal(params.model, "gemini-4-argon-high");
  assert.equal(createParams({ ...claude, allowHomeCwd: true }).allowHomeCwd, true);
  assert.equal("allowHomeCwd" in createParams(claude), false);
});

test("adopting sends the running agent's pane and a trimmed name", () => {
  assert.deepEqual(adoptParams({ paneId: "t7" }, " Scout "), { name: "Scout", adoptPaneId: "t7" });
});

test("API errors become sentences a person can act on", () => {
  assert.match(describeError({ code: "invalid_launch_options" }), /model/);
  assert.match(describeError({ code: "bot_exists" }), /already exists/);
  assert.match(describeError({ code: "home_cwd_requires_confirmation" }), /home folder/);
  assert.match(describeError({ code: "herdr_error", message: "boom" }), /boom/);
  assert.equal(describeError({ message: "plain" }), "plain");
  assert.equal(describeError(undefined), "Something went wrong.");
  assert.equal(providerById("claude").label, "Claude Code");
});
