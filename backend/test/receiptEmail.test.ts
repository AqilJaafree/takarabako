import { test } from "node:test";
import assert from "node:assert/strict";
import { maskEmail, receiptHtml } from "../src/receiptEmail.js";

const receipt = {
  id: "8e369540-0000-0000-0000-000000000000", privyUserId: "u", status: "finished" as const,
  startedAt: new Date("2026-09-27T08:05:00Z"), finishedAt: new Date("2026-09-27T08:07:00Z"),
  currency: "MYR", totalAmount: 11, totalUsdConfirmed: 2.45, settled: true,
  notes: [
    { id: "1", amount: 10, currency: "MYR", usdAmount: 2.45, txHash: "0x" + "a".repeat(64), tkcashTxHash: "0x" + "b".repeat(64), machineName: "tokyo-01.takarabako.eth", machineVerified: true, status: "confirmed" as const, at: new Date() },
    { id: "2", amount: 1, currency: "MYR", usdAmount: null, txHash: null, tkcashTxHash: null, machineName: null, machineVerified: false, status: "failed" as const, at: new Date() },
  ],
};

test("the kiosk shows a masked address", () => {
  assert.equal(maskEmail("sebastian@gmail.com"), "s••••••••@gmail.com");
  assert.equal(maskEmail("a@b.co"), "a@b.co");
});

test("the receipt email lists each note, the total, the machine and tkCASH", () => {
  const html = receiptHtml(receipt, "sesagi153-703e.takarabako.eth");
  assert.match(html, /RM10/);
  assert.match(html, /\$2\.45 ✓/);
  assert.match(html, /not credited/);
  assert.match(html, /Total RM11/);
  assert.match(html, /Verified machine · tokyo-01\.takarabako\.eth/);
  assert.match(html, /\+ \$2\.45 tkCASH/);
  assert.match(html, /sepolia\.etherscan\.io\/tx\/0xa{64}/);
});

test("names are escaped in the email", () => {
  assert.match(receiptHtml(receipt, "<script>x</script>"), /&lt;script&gt;x&lt;\/script&gt;/);
});
