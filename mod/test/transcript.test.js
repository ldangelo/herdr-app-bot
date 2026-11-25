import { test } from "node:test";
import assert from "node:assert/strict";
import { applyTranscriptEvent, entryView, isOneClickPrompt, isSeqGap, lastSeq, mergeEntries, upsertEntry, visibleEntries } from "../herdr-bot/transcript.js";

const e = (id, seq, extra = {}) => ({ id, seq, timestampMs: seq * 1000, kind: "message", content: `text ${id}`, author: { id: "u", name: "ray" }, ...extra });

test("entryView reads each kind of entry", () => {
  assert.deepEqual(entryView(e("a", 1)), { id: "a", seq: 1, timestampMs: 1000, role: "user", author: "ray", text: "text a" });
  const reply = entryView({ id: "b", seq: 2, timestampMs: 2000, kind: "send-message", author: "Scout", message: { type: "text", content: "hello" } });
  assert.deepEqual([reply.role, reply.author, reply.text], ["bot", "Scout", "hello"]);
  assert.deepEqual([entryView(e("n", 3, { kind: "notice", author: undefined })).role, entryView(e("n", 3, { kind: "notice" })).author], ["notice", null]);
  const card = entryView({ id: "p", seq: 4, timestampMs: 4000, kind: "prompt", status: "pending", prompt: { question: "Run it?", options: [{ key: "1", label: "Yes" }] } });
  assert.deepEqual([card.role, card.text, card.status], ["prompt", "Run it?", "pending"]);
  assert.equal(entryView(e("x", 5, { kind: "something-new" })).role, "other");
});

test("an author may be a string, an object or missing", () => {
  assert.equal(entryView(e("a", 1, { author: "Scout" })).author, "Scout");
  assert.equal(entryView(e("a", 1, { author: { name: "Ray" } })).author, "Ray");
  assert.equal(entryView(e("a", 1, { author: undefined })).author, null);
  assert.equal(entryView(e("a", 1, { author: { id: "no-name" } })).author, null);
});

test("visibleEntries drops rows with nothing to show but keeps prompt cards", () => {
  const entries = [e("a", 1), e("b", 2, { content: "   " }), e("c", 3, { kind: "send-message", content: undefined, message: { content: "" } }), { id: "p", seq: 4, timestampMs: 0, kind: "prompt", prompt: { question: "" }, status: "pending" }];
  assert.deepEqual(visibleEntries(entries).map((view) => view.id), ["a", "p"]);
});

test("upsertEntry appends in seq order, replaces by id, and never mutates", () => {
  const list = [e("a", 1), e("c", 3)];
  assert.deepEqual(upsertEntry(list, e("b", 2)).map((x) => x.id), ["a", "b", "c"]);
  const replaced = upsertEntry(list, e("a", 1, { content: "edited" }));
  assert.equal(replaced[0].content, "edited");
  assert.equal(list[0].content, "text a");
  assert.equal(replaced.length, 2);
});

test("mergeEntries unions pages by id, newer copy wins, seq order", () => {
  const merged = mergeEntries([e("c", 3), e("d", 4)], [e("a", 1), e("b", 2), e("c", 3, { content: "fresh" })]);
  assert.deepEqual(merged.map((x) => x.id), ["a", "b", "c", "d"]);
  assert.equal(merged[2].content, "fresh");
});

test("applyTranscriptEvent only touches its own chat's transcript events", () => {
  const list = [e("a", 1)];
  const appended = applyTranscriptEvent(list, "scout", { type: "transcript.entryAppended", payload: { chatId: "scout", entry: e("b", 2) } });
  assert.deepEqual(appended.map((x) => x.id), ["a", "b"]);
  const updated = applyTranscriptEvent(list, "scout", { type: "transcript.entryUpdated", payload: { chatId: "scout", entry: e("a", 1, { content: "x" }) } });
  assert.equal(updated[0].content, "x");
  assert.equal(applyTranscriptEvent(list, "scout", { type: "transcript.entryAppended", payload: { chatId: "other", entry: e("z", 9) } }), list);
  assert.equal(applyTranscriptEvent(list, "scout", { type: "chat.changed", payload: {} }), list);
  assert.equal(applyTranscriptEvent(list, "scout", { type: "transcript.entryAppended", payload: { chatId: "scout", entry: null } }), list);
});

test("lastSeq and seq gaps", () => {
  assert.equal(lastSeq([]), 0);
  assert.equal(lastSeq([e("a", 5), e("b", 2)]), 5);
  assert.equal(isSeqGap(null, 17), false, "the first event seen is never a gap");
  assert.equal(isSeqGap(4, 5), false);
  assert.equal(isSeqGap(4, 7), true);
  assert.equal(isSeqGap(4, 4), true, "a repeat is odd too: resync");
});

test("only a pending single-choice card is answerable with one click", () => {
  const card = (over = {}) => entryView({ id: "p", seq: 1, timestampMs: 0, kind: "prompt", status: "pending", prompt: { question: "Q", multiSelect: false, options: [{ key: "1", label: "Yes" }] }, ...over });
  assert.equal(isOneClickPrompt(card()), true);
  assert.equal(isOneClickPrompt(card({ status: "answered" })), false);
  assert.equal(isOneClickPrompt(card({ prompt: { question: "Q", multiSelect: true, options: [{ key: "1", label: "A" }] } })), false);
  assert.equal(isOneClickPrompt(card({ prompt: { question: "Q", multiSelect: false, options: [] } })), false);
  assert.equal(isOneClickPrompt(entryView(e("m", 1))), false);
});

test("an approval card knows which bot asked, so an answer in a room goes to that bot", () => {
  const card = entryView({ id: "p", seq: 4, timestampMs: 0, kind: "prompt", status: "pending", author: { id: "nova", name: "Nova" }, prompt: { question: "Run it?", options: [{ key: "1", label: "Yes" }] } });
  assert.deepEqual([card.role, card.author, card.botId], ["prompt", "Nova", "nova"]);
  const anonymous = entryView({ id: "q", seq: 5, timestampMs: 0, kind: "prompt", status: "pending", prompt: { question: "?" } });
  assert.deepEqual([anonymous.author, anonymous.botId], [null, null]);
  assert.equal(entryView({ id: "r", seq: 6, timestampMs: 0, kind: "prompt", author: { name: "No id" }, prompt: {} }).botId, null);
});
