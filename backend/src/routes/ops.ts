import { Router, type RequestHandler } from "express";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { config } from "../config.js";
import { asyncHandler } from "../asyncHandler.js";
import { askOpsAgent, investigateKiosk } from "../opsAgent.js";
import { checkAllKiosks, checkKiosk } from "../integrity.js";
import { mandateStatus } from "../mandate.js";
import { generateReport, getReport, listReports } from "../report.js";
import { approveProposal, listProposals, recentAlerts, rejectProposal } from "../proposals.js";
import { attestReserve, executeProposal, unfreezeKiosk } from "../treasury.js";

/// Treasury ops: ask the agent, and approve or reject what it proposes.
/// Everything that costs money or moves funds needs the operator token
/// (OPS_ADMIN_TOKEN) as a Bearer header; listing is open to the dashboard.
export const opsRouter = Router();

const requireOperator: RequestHandler = (req, res, next) => {
  const expected = config.opsAgent.adminToken;
  const given = req.header("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const ok =
    expected.length > 0 && given.length === expected.length && timingSafeEqual(Buffer.from(given), Buffer.from(expected));
  if (!ok) {
    res.status(expected ? 401 : 503).json({ error: expected ? "operator token required" : "OPS_ADMIN_TOKEN is not set" });
    return;
  }
  next();
};

const AskBody = z.object({ question: z.string().min(3).max(2000) });

opsRouter.post("/ops/ask", requireOperator, asyncHandler(async (req, res) => {
  const parsed = AskBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  res.json(await askOpsAgent(parsed.data.question));
}));

opsRouter.get("/ops/proposals", asyncHandler(async (_req, res) => {
  res.json({ proposals: await listProposals() });
}));

opsRouter.get("/ops/alerts", asyncHandler(async (_req, res) => {
  res.json({ alerts: await recentAlerts() });
}));

opsRouter.post("/ops/proposals/:id/approve", requireOperator, asyncHandler(async (req, res) => {
  const result = await approveProposal(req.params.id, executeProposal);
  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }
  res.json({ proposal: result.proposal });
}));

opsRouter.post("/ops/proposals/:id/reject", requireOperator, asyncHandler(async (req, res) => {
  const note = typeof req.body?.note === "string" ? req.body.note : undefined;
  const result = await rejectProposal(req.params.id, note);
  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }
  res.json({ proposal: result.proposal });
}));

const AttestBody = z.object({
  kioskId: z.string().min(1),
  counted: z.number().nonnegative(), // USD counted in the box
  auditRef: z.string().max(31).optional(), // who/which count, kept on-chain
});

/// POST /ops/attest — record an operator's physical cash count on-chain.
opsRouter.post("/ops/attest", requireOperator, asyncHandler(async (req, res) => {
  const parsed = AttestBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const { kioskId, counted, auditRef } = parsed.data;
  const ref = auditRef?.trim() || `count-${new Date().toISOString().slice(0, 16)}`;
  res.json({ txHash: await attestReserve(kioskId, counted, ref) });
}));

/// POST /ops/kiosks/:kioskId/unfreeze — a human cleared a count mismatch.
opsRouter.post("/ops/kiosks/:kioskId/unfreeze", requireOperator, asyncHandler(async (req, res) => {
  res.json({ txHash: await unfreezeKiosk(req.params.kioskId) });
}));

/// GET /ops/integrity — every kiosk's cash-integrity check (the dashboard).
opsRouter.get("/ops/integrity", asyncHandler(async (_req, res) => {
  res.json({ kiosks: await checkAllKiosks() });
}));

/// POST /ops/integrity/:kioskId/investigate — the agent looks into a kiosk's
/// findings and acts within its mandate.
opsRouter.post("/ops/integrity/:kioskId/investigate", requireOperator, asyncHandler(async (req, res) => {
  const report = await checkKiosk(req.params.kioskId);
  res.json({ report, run: await investigateKiosk(report, "ask") });
}));

/// GET /ops/mandate — what the agent may do on its own, and today's usage.
opsRouter.get("/ops/mandate", asyncHandler(async (_req, res) => {
  res.json(await mandateStatus());
}));

/// GET /ops/reports — the agent's daily reports (public proof of reserve).
opsRouter.get("/ops/reports", asyncHandler(async (_req, res) => {
  res.json({ reports: await listReports() });
}));

/// GET /ops/reports/:id — one report with the exact canonical JSON whose
/// keccak256 is anchored on-chain, for independent verification.
opsRouter.get("/ops/reports/:id", asyncHandler(async (req, res) => {
  const report = await getReport(req.params.id);
  if (!report) {
    res.status(404).json({ error: "no such report" });
    return;
  }
  res.json({ report });
}));

/// POST /ops/reports — write and anchor a report now.
opsRouter.post("/ops/reports", requireOperator, asyncHandler(async (_req, res) => {
  res.json({ report: await generateReport() });
}));
