import { test } from "node:test";
import assert from "node:assert/strict";
import { reconcile, type IntegrityInput } from "../src/integrity.js";

const NOW = Date.parse("2026-09-27T12:00:00Z");
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();

const clean = (): IntegrityInput => ({
  kioskId: "tokyo-01",
  reserve: 20,
  frozen: false,
  notes: [
    { id: "d1", usd: 10, signed: true, status: "confirmed", mintTx: "0xaa", at: ago(120) },
    { id: "d2", usd: 10, signed: true, status: "confirmed", mintTx: "0xbb", at: ago(60) },
  ],
  mints: [
    { txHash: "0xAA", usd: 10, at: ago(119) },
    { txHash: "0xbb", usd: 10, at: ago(59) },
  ],
  counts: [{ counted: 20, onChain: 20, delta: 0, at: ago(30) }],
  now: NOW,
});

test("three records that agree are clear", () => {
  const r = reconcile(clean());
  assert.equal(r.status, "clear");
  assert.deepEqual(r.findings, []);
  assert.deepEqual(r.machine, { notes: 2, usd: 20, unsigned: 0 });
  assert.equal(r.chain.mints, 2);
});

test("a short count means cash left the box", () => {
  const input = clean();
  input.counts = [{ counted: 10, onChain: 20, delta: -10, at: ago(5) }];
  const r = reconcile(input);
  assert.equal(r.status, "critical");
  assert.equal(r.findings[0].code, "count_short");
  assert.match(r.findings[0].title, /\$10\.00 short/);
});

test("a mint with no machine-signed note is flagged", () => {
  const input = clean();
  input.mints.push({ txHash: "0xcc", usd: 50, at: ago(10) });
  const r = reconcile(input);
  assert.equal(r.status, "critical");
  const f = r.findings.find((x) => x.code === "mint_without_signed_note");
  assert.ok(f);
  assert.match(f!.detail, /\$50\.00/);
});

test("a confirmed note that never minted is flagged after the lag", () => {
  const input = clean();
  input.notes.push({ id: "d3", usd: 5, signed: true, status: "confirmed", mintTx: null, at: ago(30) });
  input.notes.push({ id: "d4", usd: 5, signed: true, status: "confirmed", mintTx: null, at: ago(2) }); // still within the lag
  const r = reconcile(input);
  const f = r.findings.find((x) => x.code === "note_not_minted");
  assert.ok(f);
  assert.match(f!.title, /^1 note/);
});

test("unsigned notes, a never-counted box and a frozen kiosk", () => {
  const input = clean();
  input.notes[0].signed = false;
  input.counts = [];
  input.frozen = true;
  const codes = reconcile(input).findings.map((f) => f.code);
  assert.ok(codes.includes("unsigned_notes"));
  assert.ok(codes.includes("never_counted"));
  assert.ok(codes.includes("kiosk_frozen"));
  // the unsigned note's mint now has no signed note behind it
  assert.ok(codes.includes("mint_without_signed_note"));
});

test("a stale count is informational", () => {
  const input = clean();
  input.counts = [{ counted: 20, onChain: 20, delta: 0, at: ago(5 * 24 * 60) }];
  const r = reconcile(input);
  assert.equal(r.status, "clear");
  assert.equal(r.findings[0].code, "stale_count");
});
