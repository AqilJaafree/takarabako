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
import { getKiosk, listKiosks, normalizeKioskId, registerKiosk, setKioskActive } from "../kiosks.js";
import { advanceTransfer, createTransfer, getTransfer, listTransfers, validateAmount, validateRoute } from "../bridge.js";
import { isCashChain, type CashChainKey } from "../config.js";
import { chainOps } from "../chain.js";

/// Treasury ops: ask the agent, and approve or reject what it proposes.
/// Everything that costs money or moves funds needs the operator token
/// (OPS_ADMIN_TOKEN) as a Bearer header; listing is open to the dashboard.
export const opsRouter = Router();

/// The chain an operator action on a kiosk applies to: the one named, else the kiosk's registered home chain.
async function kioskChain(kioskId: string, named: unknown): Promise<CashChainKey> {
  if (typeof named === "string" && named) {
    if (!isCashChain(named)) throw Object.assign(new Error(`unknown chain "${named}"`), { status: 400 });
    return named;
  }
  const home = (await getKiosk(kioskId))?.chain;
  return home && isCashChain(home) ? home : config.defaultChain;
}

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
  chain: z.string().optional(), // default: the kiosk's home chain
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
  res.json({ txHash: await attestReserve(kioskId, counted, ref, await kioskChain(kioskId, parsed.data.chain)) });
}));

/// POST /ops/kiosks/:kioskId/unfreeze — a human cleared a count mismatch.
opsRouter.post("/ops/kiosks/:kioskId/unfreeze", requireOperator, asyncHandler(async (req, res) => {
  res.json({ txHash: await unfreezeKiosk(req.params.kioskId, await kioskChain(req.params.kioskId, req.body?.chain)) });
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

/// ---- Kiosk registry ------------------------------------------------------
/// A kiosk generates its signing key on the device (device-agent/machine.js);
/// the operator registers the public address here. Notes signed by any other
/// key are credited as unverified (or refused, with MACHINE_SIGNATURE=required).

const KioskBody = z.object({
  id: z.string().min(2).max(40),
  signer: z.string().regex(/^0x[0-9a-fA-F]{40}$/, "a 0x wallet address"),
  label: z.string().max(80).optional(),
  chain: z.string().default("sepolia"),
});

opsRouter.get("/ops/kiosks", asyncHandler(async (_req, res) => {
  res.json({ kiosks: await listKiosks() });
}));

opsRouter.post("/ops/kiosks", requireOperator, asyncHandler(async (req, res) => {
  const parsed = KioskBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  if (!isCashChain(parsed.data.chain)) {
    res.status(400).json({ error: `unknown chain "${parsed.data.chain}"` });
    return;
  }
  const id = normalizeKioskId(parsed.data.id);
  if (!/^[a-z0-9-]{2,40}$/.test(id)) {
    res.status(400).json({ error: "kiosk id: 2 to 40 letters, digits or hyphens" });
    return;
  }
  res.status(201).json({ kiosk: await registerKiosk({ ...parsed.data, id }) });
}));

opsRouter.post("/ops/kiosks/:id/active", requireOperator, asyncHandler(async (req, res) => {
  const active = req.body?.active !== false;
  if (!(await getKiosk(req.params.id))) {
    res.status(404).json({ error: "unknown kiosk" });
    return;
  }
  await setKioskActive(req.params.id, active);
  res.json({ kiosk: await getKiosk(req.params.id) });
}));

/// ---- Treasury rebalance between chains (CCTP) ------------------------------

const Rebalance = z.object({ from: z.string(), to: z.string(), amount: z.number().positive() });

opsRouter.get("/ops/bridge", asyncHandler(async (_req, res) => {
  res.json({ transfers: await listTransfers({ limit: 30 }) });
}));

opsRouter.post("/ops/bridge/rebalance", requireOperator, asyncHandler(async (req, res) => {
  const parsed = Rebalance.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const route = validateRoute(parsed.data.from, parsed.data.to);
  validateAmount(parsed.data.amount);
  const transfer = await createTransfer({
    privyUserId: null,
    kind: "treasury",
    from: route.from,
    to: route.to,
    amountUsd: parsed.data.amount,
    recipient: chainOps(route.to).treasuryAddress ?? "",
  });
  void advanceTransfer(transfer.id).catch((err) => console.error("[bridge] advance:", err instanceof Error ? err.message : err));
  res.status(202).json({ transfer });
}));

opsRouter.get("/ops/bridge/:id", asyncHandler(async (req, res) => {
  const t = await getTransfer(String(req.params.id));
  if (!t) {
    res.status(404).json({ error: "transfer not found" });
    return;
  }
  res.json({ transfer: t });
}));
