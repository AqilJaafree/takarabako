import type { Account } from "./accounts.js";
import { recordYieldEvent } from "./history.js";
import { issueName, positionSubname } from "./ens.js";
import { closePosition, ethUsd, listPositions, openPosition, viewPosition, type OpenRequest, type PositionRow, type PositionView } from "./aqua.js";
import { TIERS } from "./aquaMath.js";

/// The customer-facing side of Aqua yield: opening a position records it in
/// History and gives it an ENS name; closing records that too. Shared by the
/// web app, the kiosk and withdraw.

export interface OpenedPosition {
  position: PositionView;
  ensName: string;
}

export async function openForCustomer(account: Account, req: Omit<OpenRequest, "privyUserId" | "boundAddress">): Promise<OpenedPosition> {
  const row = await openPosition({ ...req, privyUserId: account.privyUserId, boundAddress: account.boundAddress });
  const ensName = positionSubname(row.id);
  // The name is the position's deed: an ENS v2 token in the customer's own
  // wallet that they can send to someone else, and the position follows it.
  // A failed registration never undoes the position.
  await issueName({
    name: ensName,
    owner: account.privyWallet,
    transferable: true,
    texts: { "takarabako.kind": "aqua-position", "takarabako.position": row.id, "takarabako.strategy": `${row.mode}/${row.shape}` },
  }).catch((err) => console.error(`[ens] ${ensName}:`, err instanceof Error ? err.message : err));
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
    ensName,
    txHash: row.strategies[0]?.shipTx ?? null,
  });
  return { position: view, ensName };
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
    ensName: positionSubname(row.id),
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
        ensName: positionSubname(row.id),
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
