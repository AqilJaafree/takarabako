// Sets up the MultiBaas deployment this backend uses. Safe to re-run: every
// step skips or updates what already exists.
//
//   cd contracts && forge build        (the ABIs come from contracts/out)
//   cd backend && npm run mb:setup
//
// 1. uploads five contract ABIs (the free tier's cap) under stable labels
// 2. creates address aliases and links each address to its ABI, indexing
//    from the latest block (the free tier looks back only 100 blocks)
// 3. saves the Event Queries the dashboard runs
// 4. registers the webhook that streams events to /webhooks/multibaas
import { readFile } from "node:fs/promises";
import { parseAbi, type Abi } from "viem";
import type { EventQuery } from "@curvegrid/multibaas-sdk";
import { config } from "../src/config.js";
import { ALIASES, LABELS, mb, mbError, multibaasReady } from "../src/multibaas.js";
import { treasuryAddress } from "../src/chain.js";

if (!multibaasReady) {
  console.error("Set MULTIBAAS_URL and MULTIBAAS_API_KEY in backend/.env first.");
  process.exit(1);
}

const UNISWAP_NPM = "0x1238536071E1c677A632429e3655c799b22cDA52";
const ENS_USER_REGISTRY = "0x786441fDe1a4006EadD745A8b90d8621F7a99916";
const VERSION = "1.0";

async function foundryAbi(contract: string): Promise<Abi> {
  const path = new URL(`../../contracts/out/${contract}.sol/${contract}.json`, import.meta.url);
  try {
    return JSON.parse(await readFile(path, "utf8")).abi;
  } catch {
    throw new Error(`missing ${path.pathname} — run \`forge build\` in contracts/ first`);
  }
}

// Only the parts of these third-party contracts we call or index.
const npmAbi = parseAbi([
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
  "event IncreaseLiquidity(uint256 indexed tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)",
  "event DecreaseLiquidity(uint256 indexed tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)",
  "event Collect(uint256 indexed tokenId, address recipient, uint256 amount0, uint256 amount1)",
  "function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)",
]);
const ensAbi = parseAbi([
  "event LabelRegistered(uint256 indexed tokenId, bytes32 indexed labelHash, string label, address owner, uint64 expiry, address indexed sender)",
  "function register(string label, address owner, address registry, address resolver, uint256 roleBitmap, uint64 expiry) returns (uint256)",
  "function findOwner(string label) view returns (address)",
]);

const contracts: Array<{ label: string; name: string; alias: string; address: string; abi: () => Promise<Abi> }> = [
  { label: LABELS.vault, name: "TakarabakoVault", alias: ALIASES.vault, address: config.vaultAddress, abi: () => foundryAbi("TakarabakoVault") },
  { label: LABELS.cashReceipt, name: "TakarabakoCashReceipt", alias: ALIASES.tkcash, address: config.cashReceiptAddress, abi: () => foundryAbi("TakarabakoCashReceipt") },
  { label: LABELS.usdc, name: "MockUSDC", alias: ALIASES.musdc, address: config.usdcAddress, abi: () => foundryAbi("MockUSDC") },
  { label: LABELS.uniswapNpm, name: "NonfungiblePositionManager", alias: "uniswap-npm", address: UNISWAP_NPM, abi: async () => npmAbi },
  { label: LABELS.ensRegistry, name: "UserRegistry", alias: "ens-wantest", address: ENS_USER_REGISTRY, abi: async () => ensAbi },
];

const status = (err: unknown) => (err as { response?: { status?: number } })?.response?.status;

async function step(what: string, run: () => Promise<unknown>, okIfConflict = true) {
  try {
    await run();
    console.log(`  ✓ ${what}`);
  } catch (err) {
    if (okIfConflict && status(err) === 409) {
      console.log(`  · ${what} (already there)`);
      return;
    }
    console.error(`  ✗ ${what}: ${mbError(err).message}`);
  }
}

console.log("1. Contract ABIs");
for (const c of contracts) {
  const abi = await c.abi();
  await step(`${c.label} (${c.name})`, () =>
    mb.contracts.createContract(c.label, { label: c.label, contractName: c.name, version: VERSION, rawAbi: JSON.stringify(abi) }),
  );
}

console.log("2. Addresses, aliases and links");
if (treasuryAddress) await step(`alias ${ALIASES.treasury} → ${treasuryAddress}`, () => mb.addresses.setAddress({ alias: ALIASES.treasury, address: treasuryAddress! }), false);
for (const c of contracts) {
  if (!c.address) {
    console.log(`  - ${c.label}: no address configured, skipped (set it in .env and re-run)`);
    continue;
  }
  await step(`alias ${c.alias} → ${c.address}`, () => mb.addresses.setAddress({ alias: c.alias, address: c.address }), false);
  await step(`link ${c.alias} ↔ ${c.label}`, () =>
    mb.contracts.linkAddressContract(c.alias, { label: c.label, version: VERSION, startingBlock: "latest" }),
  );
}

console.log("3. Event Queries");
const onlyContract = (label: string) => ({ rule: "and" as const, children: [{ fieldType: "contract_label" as const, operator: "equal" as const, value: label }] });
const input = (name: string, aggregator?: "add" | "subtract", alias?: string) => ({
  type: "input" as const,
  name,
  alias: alias ?? name,
  ...(aggregator ? { aggregator } : {}),
});

const CASH_IN = "CashIn(bytes32,address,uint256,uint32,bytes3)";
const queries: Record<string, EventQuery> = {
  // Proof of reserve: USD minted per kiosk.
  cash_in_by_kiosk: {
    events: [{ eventName: CASH_IN, select: [input("kioskId"), input("amount", "add", "total")], filter: onlyContract(LABELS.cashReceipt) }],
  },
  // Banknote mix: how much came in per face value.
  cash_in_by_denomination: {
    events: [{ eventName: CASH_IN, select: [input("denomination"), input("amount", "add", "total")], filter: onlyContract(LABELS.cashReceipt) }],
  },
  // tkCASH holders: + what each address received, − what it sent.
  tkcash_holders: {
    events: [
      { eventName: "Transfer(address,address,uint256)", select: [input("to", undefined, "holder"), input("value", "add", "balance")], filter: onlyContract(LABELS.cashReceipt) },
      { eventName: "Transfer(address,address,uint256)", select: [input("from", undefined, "holder"), input("value", "subtract", "balance")], filter: onlyContract(LABELS.cashReceipt) },
    ],
    groupBy: "holder",
  },
  // Vault principal deposited per (bound) address.
  deposits_by_user: {
    events: [{ eventName: "Deposited(address,uint256,uint256)", select: [input("user"), input("usdcAmount", "add", "total")], filter: onlyContract(LABELS.vault) }],
  },
  // Every withdrawal, for the flows chart.
  withdrawals: {
    events: [
      {
        eventName: "Withdrawn(address,address,uint256,uint256)",
        select: [input("owner"), input("recipient"), input("usdcAmount"), { type: "triggered_at", alias: "at" }, { type: "tx_hash", alias: "txHash" }],
        filter: onlyContract(LABELS.vault),
      },
    ],
    orderBy: "at",
    order: "DESC",
  },
  // Operator counts against the chain's reserve.
  reserve_attestations: {
    events: [
      {
        eventName: "ReserveAttested(bytes32,uint256,uint256,int256,bytes32)",
        select: [input("kioskId"), input("counted"), input("onChain"), input("delta"), input("auditRef"), { type: "triggered_at", alias: "at" }],
        filter: onlyContract(LABELS.cashReceipt),
      },
    ],
    orderBy: "at",
    order: "DESC",
  },
};
for (const [name, query] of Object.entries(queries)) {
  await step(name, () => mb.queries.setEventQuery(name, query), false);
}

console.log("4. Webhook");
if (!config.publicBackendUrl) {
  console.log("  - PUBLIC_BACKEND_URL not set: skipped. Start a tunnel to :4000, set it, and re-run.");
} else {
  const url = `${config.publicBackendUrl}/webhooks/multibaas`;
  const label = "takarabako-backend";
  try {
    const { data } = await mb.webhooks.listWebhooks();
    const existing = (data.result as Array<{ id: number; label: string; url: string }>).find((w) => w.label === label);
    if (existing && existing.url === url) {
      console.log(`  · ${label} → ${url} (already there; secret unchanged)`);
    } else {
      if (existing) await mb.webhooks.deleteWebhook(existing.id);
      const { data: created } = await mb.webhooks.createWebhook({ url, label, subscriptions: ["event.emitted"] });
      const secret = (created.result as { secret: string }).secret;
      console.log(`  ✓ ${label} → ${url}`);
      console.log(`\n  Put this in backend/.env and restart the backend:\n  MULTIBAAS_WEBHOOK_SECRET=${secret}\n`);
    }
  } catch (err) {
    console.error(`  ✗ webhook: ${mbError(err).message}`);
  }
}

console.log("Done.");
