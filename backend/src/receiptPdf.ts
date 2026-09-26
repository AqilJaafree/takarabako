import PDFDocument from "pdfkit";
import type { Receipt } from "./history.js";

/// The deposit receipt as a PDF: a paper-receipt layout in the app's
/// lacquer and gold. Standard PDF fonts have no Japanese glyphs, so the
/// header spells out TAKARABAKO instead of 宝箱.

const LACQUER = "#8f1e18";
const GOLD = "#c4913a";
const INK = "#1a0f0d";
const MUTED = "#6e5a4a";

const money = (n: number) => `$${n.toFixed(2)}`;
const face = (amount: number, currency: string) => (currency === "MYR" ? `RM${amount}` : money(amount));
const short = (h: string) => `${h.slice(0, 10)}…${h.slice(-6)}`;

export function receiptPdf(r: Receipt, account: { email: string; ensName: string | null }): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    // Page height follows the number of notes (a receipt, not a letter).
    const notes = Math.min(r.notes.length, 14);
    const height = Math.max(460, 330 + notes * 30);
    const doc = new PDFDocument({ size: [360, height], margins: { top: 0, bottom: 28, left: 28, right: 28 }, info: { Title: `Takarabako receipt ${r.id.slice(0, 8)}`, Author: "Takarabako" } });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    const W = 360 - 56;

    // Header band.
    doc.rect(0, 0, 360, 96).fill(LACQUER);
    doc.rect(0, 96, 360, 3).fill(GOLD);
    doc.fillColor("#f4e9da").font("Times-Bold").fontSize(22).text("TAKARABAKO", 28, 30, { characterSpacing: 3 });
    doc.fillColor("#e3b36a").font("Helvetica").fontSize(9).text("DEPOSIT RECEIPT", 28, 62, { characterSpacing: 2 });
    doc.fillColor("#f4e9da").fontSize(9).text(`#${r.id.slice(0, 8)}`, 28, 62, { width: W, align: "right" });

    let y = 122;
    doc.fillColor(MUTED).font("Helvetica").fontSize(8).text("DEPOSITED TO", 28, y);
    doc.fillColor(INK).font("Courier").fontSize(10).text(account.ensName ?? account.email, 28, y + 12);
    doc.fillColor(MUTED).font("Helvetica").fontSize(8).text((r.finishedAt ?? r.startedAt).toUTCString(), 28, y + 28);
    y += 52;

    // Notes.
    doc.moveTo(28, y).lineTo(28 + W, y).dash(2, { space: 2 }).strokeColor("#c9a07a").stroke().undash();
    y += 10;
    for (const n of r.notes) {
      const status =
        n.status === "confirmed" ? money(n.usdAmount ?? 0) : n.status === "failed" ? "not credited" : "confirming";
      doc.fillColor(INK).font("Courier-Bold").fontSize(11).text(face(n.amount, n.currency), 28, y);
      doc
        .fillColor(n.status === "confirmed" ? "#2e7d4f" : n.status === "failed" ? LACQUER : "#9a6a00")
        .font("Courier")
        .fontSize(11)
        .text(status, 28, y, { width: W, align: "right" });
      if (n.txHash) doc.fillColor(MUTED).font("Courier").fontSize(7).text(`tx ${short(n.txHash)}`, 28, y + 14);
      y += n.txHash ? 30 : 22;
      if (y > height - 150) break; // keep to one page; the email lists every note
    }
    doc.moveTo(28, y).lineTo(28 + W, y).dash(2, { space: 2 }).strokeColor("#c9a07a").stroke().undash();
    y += 14;

    // Total.
    doc.fillColor(INK).font("Helvetica").fontSize(11).text(`Total ${face(r.totalAmount, r.currency)}`, 28, y + 4);
    doc.fillColor(INK).font("Times-Bold").fontSize(20).text(money(r.totalUsdConfirmed), 28, y, { width: W, align: "right" });
    y += 36;

    const machine = r.notes.find((n) => n.machineVerified && n.machineName)?.machineName;
    if (machine) {
      doc.fillColor("#2e7d4f").font("Helvetica").fontSize(9).text(`Verified machine · ${machine}`, 28, y, { width: W, align: "center" });
      y += 16;
    }
    const tk = r.notes.filter((n) => n.status === "confirmed" && n.tkcashTxHash).reduce((s, n) => s + (n.usdAmount ?? 0), 0);
    if (tk > 0) {
      doc.fillColor(INK).font("Helvetica").fontSize(9).text(`+ ${money(tk)} tkCASH — a token for your cash in this box`, 28, y, { width: W, align: "center" });
      y += 16;
    }

    doc.fillColor(MUTED).font("Helvetica").fontSize(7.5).text(
      "Each credited note is an Ethereum Sepolia transaction; check it on sepolia.etherscan.io with the tx shown above.",
      28,
      y + 10,
      { width: W, align: "center" },
    );
    doc.end();
  });
}
