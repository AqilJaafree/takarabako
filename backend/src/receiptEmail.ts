import { findByPrivyUserId } from "./accounts.js";
import { getReceipt, markReceiptEmailed, type Receipt } from "./history.js";
import { sendEmail } from "./mailer.js";

const money = (n: number) => `$${n.toFixed(2)}`;
const face = (amount: number, currency: string) => (currency === "MYR" ? `RM${amount}` : money(amount));

function receiptHtml(r: Receipt, ensName: string | null) {
  const rows = r.notes
    .map((n) => {
      const credited =
        n.status === "confirmed"
          ? `${money(n.usdAmount ?? 0)} · <a href="https://sepolia.etherscan.io/tx/${n.txHash}">${n.txHash?.slice(0, 10)}…</a>`
          : "not credited — please contact us";
      return `<tr><td style="padding:6px 12px 6px 0">${face(n.amount, n.currency)}</td><td style="padding:6px 0">${credited}</td></tr>`;
    })
    .join("");
  return `
    <div style="font-family:Georgia,serif;max-width:420px;padding:24px;border:1px solid #e3b36a;border-radius:12px;background:#fffaf2;color:#1a0f0d">
      <p style="font-size:22px;margin:0 0 4px">宝箱 Takarabako</p>
      <p style="margin:0 0 16px;color:#6e5a4a">Deposit receipt${ensName ? ` · ${ensName}` : ""}</p>
      <table style="width:100%;border-collapse:collapse;font-family:monospace;font-size:14px">${rows}</table>
      <hr style="border:none;border-top:1px dashed #c9a07a;margin:16px 0" />
      <p style="margin:0;font-size:18px">Total ${face(r.totalAmount, r.currency)} → <b>${money(r.totalUsdConfirmed)}</b> in your box</p>
      <p style="margin:12px 0 0;color:#6e5a4a;font-size:12px">${(r.finishedAt ?? r.startedAt).toUTCString()} · receipt ${r.id.slice(0, 8)}</p>
    </div>`;
}

/// Emails the receipt once the session is finished and every note in it has
/// settled (confirmed or failed). Safe to call repeatedly: only the first
/// call that finds the session settled sends it.
export async function maybeSendReceipt(sessionId: string) {
  const receipt = await getReceipt(sessionId);
  if (!receipt || receipt.status !== "finished" || !receipt.settled || receipt.notes.length === 0) return;
  if (!(await markReceiptEmailed(sessionId))) return; // already sent

  const account = await findByPrivyUserId(receipt.privyUserId);
  if (!account) return;
  const sent = await sendEmail({
    to: account.email,
    subject: `Takarabako receipt — ${face(receipt.totalAmount, receipt.currency)} deposited`,
    html: receiptHtml(receipt, account.ensName),
  });
  if (sent) console.log(`[receipt] emailed ${receipt.id} to ${account.email}`);
}
