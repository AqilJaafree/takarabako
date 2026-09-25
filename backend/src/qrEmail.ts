import QRCode from "qrcode";
import { Resend } from "resend";
import { config } from "./config.js";

const resend = config.resend.apiKey ? new Resend(config.resend.apiKey) : null;

/// Emails the customer the QR of their Privy wallet address — what they show
/// the kiosk camera next time to deposit without typing their email.
/// Never throws: a failed email must not fail registration. On failure the
/// caller gets a data URL to show the QR on the kiosk screen instead.
export async function sendQrEmail(to: string, wallet: string, ensName: string | null) {
  const png = await QRCode.toBuffer(wallet, { width: 480, margin: 2 });
  const dataUrl = `data:image/png;base64,${png.toString("base64")}`;

  if (!resend || !config.resend.from) {
    console.warn("[qr-email] RESEND_API_KEY/RESEND_FROM not set — showing the QR on the kiosk instead");
    return { sent: false as const, dataUrl };
  }

  try {
    const { error } = await resend.emails.send({
      from: config.resend.from,
      to,
      subject: "Your Takarabako quick-deposit QR",
      html: `
        <p>Welcome to Takarabako${ensName ? ` — your account is <b>${ensName}</b>` : ""}.</p>
        <p>Next time, show this QR to the kiosk camera to deposit cash without typing your email.
        It only allows deposits; log in with your email to withdraw or earn yield.</p>
        <p><img src="cid:wallet-qr" alt="Your wallet QR" width="240" height="240" /></p>
        <p style="font-family:monospace">${wallet}</p>`,
      attachments: [{ filename: "takarabako-qr.png", content: png, contentId: "wallet-qr" }],
    });
    if (error) {
      console.error(`[qr-email] Resend rejected the email: [${error.name}] ${error.message}`);
      return { sent: false as const, dataUrl };
    }
  } catch (err) {
    console.error("[qr-email] could not reach Resend:", err);
    return { sent: false as const, dataUrl };
  }
  return { sent: true as const, dataUrl };
}
