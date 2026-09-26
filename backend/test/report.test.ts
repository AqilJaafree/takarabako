import { test } from "node:test";
import assert from "node:assert/strict";
import { hexToString, slice } from "viem";
import { anchorData, ANCHOR_PREFIX, canonicalize, hashCanonical } from "../src/report.js";

const base = { version: 1 as const, generatedAt: "2026-09-27T00:00:00.000Z", model: "openai/gpt-5-mini", status: "clear", body: "**Status:** all clear", data: { a: 1 } };

test("the same report always hashes the same; any edit changes the hash", () => {
  const h1 = hashCanonical(canonicalize(base));
  assert.equal(h1, hashCanonical(canonicalize({ ...base })));
  assert.notEqual(h1, hashCanonical(canonicalize({ ...base, body: "**Status:** all clear!" })));
  assert.match(h1, /^0x[0-9a-f]{64}$/);
});

test("the anchor calldata is the prefix followed by the hash", () => {
  const h = hashCanonical(canonicalize(base));
  const data = anchorData(h);
  const prefixLen = ANCHOR_PREFIX.length;
  assert.equal(hexToString(slice(data, 0, prefixLen)), ANCHOR_PREFIX);
  assert.equal(slice(data, prefixLen), h);
});
