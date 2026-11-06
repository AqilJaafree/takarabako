import type { Account } from "./accounts.js";
import { recordYieldEvent } from "./history.js";
import { positionLabel } from "./labels.js";
import { closePosition, ethUsd, listPositions, openPosition, viewPosition, type OpenRequest, type PositionRow, type PositionView } from "./aqua.js";
import { TIERS } from "./aquaMath.js";
import { assertWithinLimit } from "./limits.js";

/// The customer-facing side of Aqua yield: opening a position records it in
/// History and a short tag; closing records that too. Shared by the
/// web app, the kiosk and withdraw.

export interface OpenedPosition {
  position: PositionView;
  name: string;
}

export async function openForCustomer(account: Account, req: Omit<OpenRequest, "privyUserId" | "boundAddress">): Promise<OpenedPosition> {
  await assertWithinLimit(account, req.amount, "this position");
  const row = await openPosition({ ...req, privyUserId: account.privyUserId, boundAddress: account.boundAddress });
  const name = positionLabel(row.id);
  const spot = await ethUsd();
  const view = await viewPosition(row, spot);
  await recordYieldEvent({
    privyUserId: account.privyUserId,
    action: "open",
    riskTier: row.mode,
    pair: `ETH/USDC · ${view.label}`,
    apyBps: row.apyEstBps,
    amountUsd: row.amountUsd,
    rationale: row.rationale,
    label: name,
    txHash: row.strategies[0]?.shipTx ?? null,
  });
  return { position: view, name };
}

export async function closeForCustomer(account: Account, row: PositionRow) {
  const { value, closeTx } = await closePosition(row, account.boundAddress);
  await recordYieldEvent({
    privyUserId: account.privyUserId,
    action: "close",
    riskTier: row.mode,
    pair: row.mode === "advanced" ? "ETH/USDC · Advanced" : `ETH/USDC · ${TIERS[row.mode].label}`,
    apyBps: row.apyEstBps,
    amountUsd: value,
    rationale: null,
    label: positionLabel(row.id),
    txHash: closeTx,
  });
  return { value, closeTx };
}

/// Closes every open position, returning their value to the vault. Used by withdraw.
export async function closeAllForCustomer(account: Account) {
  const open = await listPositions(account.privyUserId, "open");
  let total = 0;
  for (const row of open) total += (await closeForCustomer(account, row)).value;
  return { closed: open.length, valueUsd: total };
}

/// The compact shape My box and the kiosk show (and the 3D box's gems).
export async function positionSummaries(privyUserId: string) {
  const rows = await listPositions(privyUserId, "open");
  if (!rows.length) return [];
  const spot = await ethUsd().catch(() => null);
  return Promise.all(
    rows.map(async (row) => {
      const view = spot ? await viewPosition(row, spot).catch(() => null) : null;
      return {
        positionId: row.id,
        name: positionLabel(row.id),
        riskTier: row.mode === "advanced" ? ("high" as const) : row.mode,
        mode: row.mode,
        shape: row.shape,
        pair: "ETH/USDC",
        label: view?.label ?? row.mode,
        amount: view?.valueUsd ?? row.amountUsd,
        apyBps: row.apyEstBps,
        inRange: view?.inRange ?? null,
        priceMin: row.priceMin,
        priceMax: row.priceMax,
      };
    }),
  );
}
