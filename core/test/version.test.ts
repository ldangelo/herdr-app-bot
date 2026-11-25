import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { HOST_VERSION } from "../src/version.ts";

const root = resolve(import.meta.dirname, "../..");

test("HOST_VERSION matches package.json: bump them together", () => {
  assert.equal(HOST_VERSION, (JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as { version: string }).version);
  assert.match(HOST_VERSION, /^\d+\.\d+\.\d+$/);
});
