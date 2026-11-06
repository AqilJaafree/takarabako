import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyPosition, needsAttention } from "../src/positionAudit.js";

const held = { eth: 5n, usdc: 5n };
const docked = { eth: 0n, usdc: 0n };
const open = { status: "open" as const, closeTx: null, closeValue: null };
const HASH = `0x${"ab".repeat(32)}`;

test("an open position whose strategies all hold balances is fine", () => {
  assert.equal(classifyPosition(open, [held, held]).kind, "ok");
});

test("an open position whose strategies are all docked was never paid", () => {
  const f = classifyPosition(open, [docked, docked]);
  assert.equal(f.kind, "docked-but-open");
  assert.equal(needsAttention(f), true);
});

test("an open position with only some strategies docked is a close that stopped halfway", () => {
  const f = classifyPosition(open, [docked, held]);
  assert.equal(f.kind, "partly-docked");
  assert.match(f.note, /1 of 2/);
  assert.equal(needsAttention(f), true);
});

test("a balance that could not be read is never judged", () => {
  const f = classifyPosition(open, [held, null]);
  assert.equal(f.kind, "unreadable");
  assert.equal(needsAttention(f), true);
});

test("a closing position says where its payout got to", () => {
  assert.equal(classifyPosition({ status: "closing", closeTx: null, closeValue: 12.5 }, [docked]).kind, "closing-unpaid");
  assert.equal(classifyPosition({ status: "closing", closeTx: "pending", closeValue: 12.5 }, [docked]).kind, "closing-in-doubt");
  assert.equal(classifyPosition({ status: "closing", closeTx: HASH, closeValue: 12.5 }, [docked]).kind, "closing-sent");
});

test("only a payout in doubt, or unpaid, needs a person; a sent one resolves by closing again", () => {
  assert.equal(needsAttention(classifyPosition({ status: "closing", closeTx: HASH, closeValue: 1 }, [docked])), false);
  assert.equal(needsAttention(classifyPosition({ status: "closing", closeTx: "pending", closeValue: 1 }, [docked])), true);
});
