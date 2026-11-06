import { test, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "./helpers.js";

const mail = (name: string, host = "example.com") => `${name}${String.fromCharCode(64)}${host}`;
const pool = await freshDb();
const { deriveLabel, positionLabel, isAddress, findCustomer } = await import("../src/labels.js");
const accounts = await import("../src/accounts.js");
after(() => pool.end());

test("a label is the cleaned email name plus a short hash", () => {
  const a = deriveLabel(mail("Alice.W"));
  assert.match(a, /^alicew-[0-9a-f]{4}$/);
  assert.notEqual(deriveLabel(mail("alice", "a.com")), deriveLabel(mail("alice", "b.com")));
  assert.match(deriveLabel(mail("!!!")), /^user-[0-9a-f]{4}$/);
});

test("a position tag is short and stable", () => {
  assert.equal(positionLabel("1a2b3c4d-0000-0000-0000-000000000000"), "aqua-1a2b3c4d");
});

test("addresses are recognised", () => {
  assert.equal(isAddress("0xAbCdEf0000000000000000000000000000000001"), true);
  assert.equal(isAddress("alice-1234"), false);
});

test("a customer is found by label or by wallet, case-insensitively", async () => {
  await accounts.insertAccount({ privyUserId: "u-l", email: mail("lee"), privyWallet: "0x00000000000000000000000000000000000000e1", boundAddress: "0x00000000000000000000000000000000000000e2", label: "Lee-1234" });
  assert.equal((await findCustomer("lee-1234"))?.privyUserId, "u-l");
  assert.equal((await findCustomer("LEE-1234"))?.wallet, "0x00000000000000000000000000000000000000e1");
  assert.equal((await findCustomer("0x00000000000000000000000000000000000000E1"))?.privyUserId, "u-l");
  assert.equal(await findCustomer("nobody"), null);
});

test("two accounts can't share a label", async () => {
  await assert.rejects(accounts.insertAccount({ privyUserId: "u-l2", email: mail("lee2"), privyWallet: "0x00000000000000000000000000000000000000e3", boundAddress: "0x00000000000000000000000000000000000000e4", label: "lee-1234" }));
});
