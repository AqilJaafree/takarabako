import { Router } from "express";
import { config } from "../config.js";
import { asyncHandler } from "../asyncHandler.js";
import { describeNetworks } from "../networks.js";
import { isNetworkKey, networkStatus } from "../networkStatus.js";

/// The networks the web app can look at. Read-only and public: it only
/// describes contracts and prices. Real positions are opened and closed on
/// the one network this backend runs on (`active`).
export const networkRouter = Router();

/// GET /networks — every network, which one is active, and where Aqua is on each.
networkRouter.get("/networks", (_req, res) => {
  res.json({
    active: config.network.key,
    networks: describeNetworks(config.network.key, {
      aqua: process.env.AQUA_ADDRESS,
      router: process.env.AQUA_ROUTER_ADDRESS,
      usdc: config.usdcAddress,
      baseToken: config.aqua.methAddress,
    }).map((n) => ({
      ...n,
      // The customer can sign positions with their own wallet here (selfPositions.ts).
      selfCustody: n.key === "arc" && config.selfCustody.arcEnabled && Boolean(n.aqua),
    })),
  });
});

/// GET /networks/:key/status — live, read-only checks of one network (cached 30s).
networkRouter.get("/networks/:key/status", asyncHandler(async (req, res) => {
  const key = String(req.params.key);
  if (!isNetworkKey(key)) {
    res.status(404).json({ error: `unknown network "${key}"` });
    return;
  }
  res.json(await networkStatus(key));
}));
