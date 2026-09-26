import QRCode from "qrcode";
import { sendEmail } from "./mailer.js";

/// Emails the customer the QR of their Privy wallet address — what they show
/// the deposit terminal's camera to deposit without typing their email.
/// Never throws: a failed email must not fail registration. On failure the
/// caller gets a data URL to show the QR on the kiosk screen instead.
export async function sendQrEmail(to: string, wallet: string, ensName: string | null) {
  const png = await QRCode.toBuffer(wallet, { width: 480, margin: 2 });
  const dataUrl = `data:image/png;base64,${png.toString("base64")}`;

  const sent = await sendEmail({
    to,
    subject: "Your Takarabako quick-deposit QR",
    html: `
      <p>Welcome to Takarabako${ensName ? ` — your account is <b>${ensName}</b>` : ""}.</p>
      <p>Next time, show this QR to the kiosk camera to deposit cash without typing your email.
      It only allows deposits; log in with your email to withdraw or earn yield.</p>
      <p><img src="cid:wallet-qr" alt="Your wallet QR" width="240" height="240" /></p>
      <p style="font-family:monospace">${wallet}</p>`,
    images: [{ cid: "wallet-qr", filename: "takarabako-qr.png", content: png }],
  });
  return sent ? { sent: true as const, dataUrl } : { sent: false as const, dataUrl };
}
