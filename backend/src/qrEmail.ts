import QRCode from "qrcode";
import { Resend } from "resend";
import nodemailer from "nodemailer";
import { config } from "./config.js";

const resend = config.resend.apiKey ? new Resend(config.resend.apiKey) : null;

// Gmail SMTP: sends from a normal Gmail account to anyone, no domain needed.
const gmail =
  config.gmail.user && config.gmail.appPassword
    ? nodemailer.createTransport({ service: "gmail", auth: { user: config.gmail.user, pass: config.gmail.appPassword } })
    : null;

const SUBJECT = "Your Takarabako quick-deposit QR";

function qrEmailHtml(wallet: string, ensName: string | null) {
  return `
    <p>Welcome to Takarabako${ensName ? ` — your account is <b>${ensName}</b>` : ""}.</p>
    <p>Next time, show this QR to the kiosk camera to deposit cash without typing your email.
    It only allows deposits; log in with your email to withdraw or earn yield.</p>
    <p><img src="cid:wallet-qr" alt="Your wallet QR" width="240" height="240" /></p>
    <p style="font-family:monospace">${wallet}</p>`;
}

/// Emails the customer the QR of their Privy wallet address — what they show
/// the kiosk camera next time to deposit without typing their email.
/// Never throws: a failed email must not fail registration. On failure the
/// caller gets a data URL to show the QR on the kiosk screen instead.
export async function sendQrEmail(to: string, wallet: string, ensName: string | null) {
  const png = await QRCode.toBuffer(wallet, { width: 480, margin: 2 });
  const dataUrl = `data:image/png;base64,${png.toString("base64")}`;

  if (gmail) {
    try {
      await gmail.sendMail({
        from: `Takarabako <${config.gmail.user}>`,
        to,
        subject: SUBJECT,
        html: qrEmailHtml(wallet, ensName),
        attachments: [{ filename: "takarabako-qr.png", content: png, cid: "wallet-qr" }],
      });
    } catch (err) {
      console.error("[qr-email] Gmail rejected the email:", err instanceof Error ? err.message : err);
      return { sent: false as const, dataUrl };
    }
    return { sent: true as const, dataUrl };
  }

  if (!resend || !config.resend.from) {
    console.warn("[qr-email] no email sender configured (GMAIL_* or RESEND_*) — showing the QR on the kiosk instead");
    return { sent: false as const, dataUrl };
  }

  try {
    const { error } = await resend.emails.send({
      from: config.resend.from,
      to,
      subject: SUBJECT,
      html: qrEmailHtml(wallet, ensName),
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
