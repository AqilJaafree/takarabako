import { findByPrivyUserId, type Account } from "./accounts.js";
import { getReceipt, markReceiptEmailed, type Receipt } from "./history.js";
import { mailConfigured, sendEmail } from "./mailer.js";
import { receiptPdf } from "./receiptPdf.js";
import { redis } from "./redis.js";
import { config } from "./config.js";

/// Deposit receipts by email: sent automatically once a finished session has
/// settled, or on demand from the kiosk ("Email me this receipt"). Always to
/// the account's own address, with the receipt attached as a PDF.

const money = (n: number) => `$${n.toFixed(2)}`;
const face = (amount: number, currency: string) => (currency === "MYR" ? `RM${amount}` : money(amount));
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const siteUrl = () => (config.publicBackendUrl ? new URL(config.publicBackendUrl).origin : "https://takarabako.bytetrix.tech");

/// "sebastian@gmail.com" → "s••••••••@gmail.com", for showing where it went.
export const maskEmail = (email: string) => email.replace(/^(.)(.*)(@.*)$/, (_m, a, b, c) => `${a}${"•".repeat(Math.min(8, b.length))}${c}`);

/// Email-safe HTML: tables and inline styles only.
export function receiptHtml(r: Receipt, ensName: string | null): string {
  const rows = r.notes
    .map((n) => {
      const right =
        n.status === "confirmed"
          ? `<span style="color:#2e7d4f;font-weight:bold">${money(n.usdAmount ?? 0)} ✓</span>${
              n.txHash ? `<br><a href="https://sepolia.etherscan.io/tx/${n.txHash}" style="color:#9a6a2a;font-size:11px;text-decoration:none">${n.txHash.slice(0, 10)}…${n.txHash.slice(-6)} ↗</a>` : ""
            }`
          : n.status === "failed"
            ? `<span style="color:#8f1e18">not credited — please contact us</span>`
            : `<span style="color:#9a6a00">confirming…</span>`;
      return `<tr>
        <td style="padding:10px 0;border-bottom:1px dashed #d9c3a5;font-family:'Courier New',monospace;font-size:15px;color:#1a0f0d">${face(n.amount, n.currency)}</td>
        <td style="padding:10px 0;border-bottom:1px dashed #d9c3a5;font-family:'Courier New',monospace;font-size:14px;text-align:right">${right}</td>
      </tr>`;
    })
    .join("");
  const machine = r.notes.find((n) => n.machineVerified && n.machineName)?.machineName;
  const tk = r.notes.filter((n) => n.status === "confirmed" && n.tkcashTxHash).reduce((s, n) => s + (n.usdAmount ?? 0), 0);
  const when = (r.finishedAt ?? r.startedAt).toUTCString();

  return `<!doctype html><html><body style="margin:0;padding:0;background:#f3ece2">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3ece2;padding:24px 12px">
    <tr><td align="center">
      <table role="presentation" width="440" cellpadding="0" cellspacing="0" style="max-width:440px;width:100%;background:#fffaf2;border-radius:14px;overflow:hidden;border:1px solid #e3cfae">
        <tr><td style="background:#8f1e18;padding:22px 26px;border-bottom:3px solid #c4913a">
          <div style="font-family:Georgia,'Times New Roman',serif;font-size:24px;color:#f4e9da;font-weight:bold">宝箱 Takarabako</div>
          <div style="font-family:Arial,sans-serif;font-size:11px;letter-spacing:2px;color:#e3b36a;margin-top:6px">DEPOSIT RECEIPT · #${r.id.slice(0, 8)}</div>
        </td></tr>
        <tr><td style="padding:22px 26px 6px">
          <div style="font-family:Arial,sans-serif;font-size:11px;letter-spacing:1px;color:#8a7462">DEPOSITED TO</div>
          <div style="font-family:'Courier New',monospace;font-size:15px;color:#1a0f0d;margin-top:4px">${esc(ensName ?? "your Takarabako box")}</div>
          <div style="font-family:Arial,sans-serif;font-size:12px;color:#8a7462;margin-top:4px">${when}</div>
        </td></tr>
        <tr><td style="padding:8px 26px">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows}</table>
        </td></tr>
        <tr><td style="padding:14px 26px 4px">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
            <td style="font-family:Arial,sans-serif;font-size:15px;color:#1a0f0d">Total ${face(r.totalAmount, r.currency)}</td>
            <td style="font-family:Georgia,serif;font-size:28px;font-weight:bold;color:#1a0f0d;text-align:right">${money(r.totalUsdConfirmed)}</td>
          </tr></table>
        </td></tr>
        ${machine ? `<tr><td style="padding:10px 26px 0;font-family:Arial,sans-serif;font-size:13px;color:#2e7d4f;text-align:center">✓ Verified machine · ${esc(machine)}</td></tr>` : ""}
        ${tk > 0 ? `<tr><td style="padding:6px 26px 0;font-family:Arial,sans-serif;font-size:13px;color:#1a0f0d;text-align:center">+ ${money(tk)} tkCASH — a token for your cash in this box</td></tr>` : ""}
        <tr><td style="padding:22px 26px" align="center">
          <a href="${siteUrl()}/history" style="display:inline-block;background:#e3b36a;color:#2a1408;font-family:Arial,sans-serif;font-weight:bold;font-size:14px;padding:12px 22px;border-radius:10px;text-decoration:none">Open my treasure box</a>
        </td></tr>
        <tr><td style="padding:0 26px 22px;font-family:Arial,sans-serif;font-size:11px;color:#8a7462;text-align:center;line-height:1.5">
          The PDF of this receipt is attached. Each credited note is a transaction on Ethereum Sepolia — tap its hash to check it.
        </td></tr>
      </table>
    </td></tr>
  </table></body></html>`;
}

async function send(receipt: Receipt, account: Account): Promise<boolean> {
  const pdf = await receiptPdf(receipt, { email: account.email, ensName: account.ensName });
  return sendEmail({
    to: account.email,
    subject: `Takarabako receipt — ${face(receipt.totalAmount, receipt.currency)} deposited`,
    html: receiptHtml(receipt, account.ensName),
    attachments: [{ filename: `takarabako-receipt-${receipt.id.slice(0, 8)}.pdf`, content: pdf, contentType: "application/pdf" }],
  });
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
  if (await send(receipt, account)) console.log(`[receipt] emailed ${receipt.id} to ${account.email}`);
}

export type EmailNowResult = { ok: true; to: string } | { ok: false; status: number; error: string };

/// "Email me this receipt" at the kiosk: the receipt as it stands now, to
/// the account's own address. At most once a minute per receipt.
export async function emailReceiptNow(sessionId: string, privyUserId: string): Promise<EmailNowResult> {
  if (!mailConfigured) return { ok: false, status: 503, error: "Email isn't set up on this kiosk yet" };
  const receipt = await getReceipt(sessionId);
  if (!receipt || receipt.privyUserId !== privyUserId) return { ok: false, status: 404, error: "receipt not found" };
  if (receipt.notes.length === 0) return { ok: false, status: 409, error: "No notes on this receipt yet" };
  const account = await findByPrivyUserId(privyUserId);
  if (!account?.email) return { ok: false, status: 404, error: "No email on this account" };
  if ((await redis.set(`receiptmail:${sessionId}`, "1", "EX", 60, "NX")) !== "OK") {
    return { ok: false, status: 429, error: "Just sent — check your inbox (you can resend in a minute)" };
  }
  if (!(await send(receipt, account))) {
    await redis.del(`receiptmail:${sessionId}`);
    return { ok: false, status: 502, error: "Couldn't send the email — please try again" };
  }
  console.log(`[receipt] emailed ${receipt.id} to ${account.email} on request`);
  return { ok: true, to: maskEmail(account.email) };
}
