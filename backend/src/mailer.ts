import { Resend } from "resend";
import nodemailer from "nodemailer";
import { config } from "./config.js";

/// Sends an email through Gmail (App Password, no domain needed) when
/// configured, otherwise Resend (verified domain). Never throws: returns
/// false when no sender is configured or sending fails, and logs why.

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

export interface InlineImage {
  cid: string; // referenced in the HTML as <img src="cid:…">
  filename: string;
  content: Buffer;
}

export async function sendEmail(msg: { to: string; subject: string; html: string; images?: InlineImage[] }): Promise<boolean> {
  const images = msg.images ?? [];

  if (gmail) {
    try {
      await gmail.sendMail({
        from: `Takarabako <${config.gmail.user}>`,
        to: msg.to,
        subject: msg.subject,
        html: msg.html,
        attachments: images.map((i) => ({ filename: i.filename, content: i.content, cid: i.cid })),
      });
      return true;
    } catch (err) {
      console.error(`[mail] Gmail rejected "${msg.subject}":`, err instanceof Error ? err.message : err);
      return false;
    }
  }

  if (resend && config.resend.from) {
    try {
      const { error } = await resend.emails.send({
        from: config.resend.from,
        to: msg.to,
        subject: msg.subject,
        html: msg.html,
        attachments: images.map((i) => ({ filename: i.filename, content: i.content, contentId: i.cid })),
      });
      if (!error) return true;
      console.error(`[mail] Resend rejected "${msg.subject}": [${error.name}] ${error.message}`);
    } catch (err) {
      console.error(`[mail] could not reach Resend for "${msg.subject}":`, err);
    }
    return false;
  }

  console.warn(`[mail] no email sender configured (GMAIL_* or RESEND_*) — "${msg.subject}" not sent`);
  return false;
}
