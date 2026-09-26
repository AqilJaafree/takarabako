import { Resend } from "resend";
import nodemailer from "nodemailer";
import { config } from "./config.js";

/// Sends an email through the first configured provider: Gmail (App
/// Password; SMTP, so it can't work where ports 465/587 are blocked, as on
/// DigitalOcean), Brevo (HTTPS API, one verified sender address), or Resend
/// (HTTPS API, verified domain). Never throws: returns false when no sender
/// is configured or sending fails, and logs why.

const gmail =
  config.gmail.user && config.gmail.appPassword
    ? nodemailer.createTransport({
        service: "gmail",
        auth: { user: config.gmail.user, pass: config.gmail.appPassword },
        // Logins wait for the QR email, so a blocked SMTP port (DigitalOcean
        // blocks 25/465/587) must fail fast, not after nodemailer's 2 minutes.
        connectionTimeout: 10_000,
        greetingTimeout: 10_000,
        socketTimeout: 20_000,
      })
    : null;

const resend = config.resend.apiKey ? new Resend(config.resend.apiKey) : null;

/// Whether any provider is set up (the kiosk offers "email me" only then).
export const mailConfigured = Boolean(gmail || (config.brevo.apiKey && config.brevo.from) || (resend && config.resend.from));

export interface InlineImage {
  cid: string; // referenced in the HTML as <img src="cid:…">
  filename: string;
  content: Buffer;
}

/// A regular attachment (e.g. a PDF receipt).
export interface Attachment {
  filename: string;
  content: Buffer;
  contentType: string;
}

/// "Name <addr@x>" → { name, email }.
function parseFrom(from: string): { name?: string; email: string } {
  const m = from.match(/^\s*(.*?)\s*<([^>]+)>\s*$/);
  return m ? { name: m[1] || undefined, email: m[2] } : { email: from.trim() };
}

export async function sendEmail(msg: { to: string; subject: string; html: string; images?: InlineImage[]; attachments?: Attachment[] }): Promise<boolean> {
  const images = msg.images ?? [];
  const files = msg.attachments ?? [];

  if (gmail) {
    try {
      await gmail.sendMail({
        from: `Takarabako <${config.gmail.user}>`,
        to: msg.to,
        subject: msg.subject,
        html: msg.html,
        attachments: [
          ...images.map((i) => ({ filename: i.filename, content: i.content, cid: i.cid })),
          ...files.map((f) => ({ filename: f.filename, content: f.content, contentType: f.contentType })),
        ],
      });
      return true;
    } catch (err) {
      console.error(`[mail] Gmail rejected "${msg.subject}":`, err instanceof Error ? err.message : err);
      return false;
    }
  }

  if (config.brevo.apiKey && config.brevo.from) {
    try {
      const res = await fetch("https://api.brevo.com/v3/smtp/email", {
        method: "POST",
        headers: { "api-key": config.brevo.apiKey, "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          sender: parseFrom(config.brevo.from),
          to: [{ email: msg.to }],
          subject: msg.subject,
          htmlContent: msg.html,
          // Brevo has no inline (cid) images: they travel as attachments.
          attachment: [...images.map((i) => ({ name: i.filename, content: i.content.toString("base64") })), ...files.map((f) => ({ name: f.filename, content: f.content.toString("base64") }))]
        }),
        signal: AbortSignal.timeout(15_000),
      });
      if (res.ok) return true;
      console.error(`[mail] Brevo rejected "${msg.subject}": ${res.status} ${(await res.text()).slice(0, 200)}`);
    } catch (err) {
      console.error(`[mail] could not reach Brevo for "${msg.subject}":`, err instanceof Error ? err.message : err);
    }
    return false;
  }

  if (resend && config.resend.from) {
    try {
      const { error } = await resend.emails.send({
        from: config.resend.from,
        to: msg.to,
        subject: msg.subject,
        html: msg.html,
        attachments: [
          ...images.map((i) => ({ filename: i.filename, content: i.content, contentId: i.cid })),
          ...files.map((f) => ({ filename: f.filename, content: f.content, contentType: f.contentType })),
        ],
      });
      if (!error) return true;
      console.error(`[mail] Resend rejected "${msg.subject}": [${error.name}] ${error.message}`);
    } catch (err) {
      console.error(`[mail] could not reach Resend for "${msg.subject}":`, err);
    }
    return false;
  }

  console.warn(`[mail] no email sender configured (GMAIL_*, BREVO_* or RESEND_*) — "${msg.subject}" not sent`);
  return false;
}
