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
import { ALIASES, LABELS, mb, mbCall, mbError, mbSend, multibaasReady, toAlias } from "../src/multibaas.js";
import { pool } from "../src/db.js";
import { aq } from "../src/aquaSdk.js";
import { treasuryAddress } from "../src/chain.js";

if (!multibaasReady) {
  console.error("Set MULTIBAAS_URL and MULTIBAAS_API_KEY in backend/.env first.");
  process.exit(1);
}

// Replaced by 1inch Aqua; unlinked on the next run (the free tier allows five).
const RETIRED = { alias: "uniswap-npm", label: "uniswap_v3_npm" };
const ENS_USER_REGISTRY = "0x786441fDe1a4006EadD745A8b90d8621F7a99916";
const VERSION = "1.0";

interface Artifact {
  abi: Abi;
  bin: string; // MultiBaas rejects a contract without bytecode, though the SDK type marks it optional
}

async function foundryArtifact(contract: string): Promise<Artifact> {
  const path = new URL(`../../contracts/out/${contract}.sol/${contract}.json`, import.meta.url);
  try {
    const json = JSON.parse(await readFile(path, "utf8"));
    return { abi: json.abi, bin: json.bytecode.object };
  } catch {
    throw new Error(`missing ${path.pathname} — run \`forge build\` in contracts/ first`);
  }
}

// Only the parts of these third-party contracts we call or index.
const ensAbi = parseAbi([
  "event LabelRegistered(uint256 indexed tokenId, bytes32 indexed labelHash, string label, address owner, uint64 expiry, address indexed sender)",
  "function register(string label, address owner, address registry, address resolver, uint256 roleBitmap, uint64 expiry) returns (uint256)",
  "function findOwner(string label) view returns (address)",
]);

// Third-party contracts: only the ABI subset; we never deploy them, so a
// placeholder bytecode satisfies MultiBaas.
const external = (abi: Abi) => async (): Promise<Artifact> => ({ abi, bin: "0x00" });

const contracts: Array<{ label: string; name: string; alias: string; address: string; artifact: () => Promise<Artifact> }> = [
  { label: LABELS.vault, name: "TakarabakoVault", alias: ALIASES.vault, address: config.vaultAddress, artifact: () => foundryArtifact("TakarabakoVault") },
  { label: LABELS.cashReceipt, name: "TakarabakoCashReceipt", alias: ALIASES.tkcash, address: config.cashReceiptAddress, artifact: () => foundryArtifact("TakarabakoCashReceipt") },
  { label: LABELS.usdc, name: "MockUSDC", alias: ALIASES.musdc, address: config.usdcAddress, artifact: () => foundryArtifact("MockUSDC") },
  { label: LABELS.aqua, name: "Aqua", alias: "aqua", address: config.aqua.address, artifact: external(aq.ABI.AQUA_ABI as unknown as Abi) },
  { label: LABELS.ensRegistry, name: "UserRegistry", alias: "ens-wantest", address: ENS_USER_REGISTRY, artifact: external(ensAbi) },
];

const status = (err: unknown) => (err as { response?: { status?: number } })?.response?.status;

async function step(what: string, run: () => Promise<unknown>, okIfConflict = true, okIfMissing = false) {
  try {
    await run();
    console.log(`  ✓ ${what}`);
  } catch (err) {
    if (okIfConflict && status(err) === 409) {
      console.log(`  · ${what} (already there)`);
      return;
    }
    if (okIfMissing && status(err) === 404) {
      console.log(`  · ${what} (already gone)`);
      return;
    }
    console.error(`  ✗ ${what}: ${mbError(err).message}`);
  }
}

console.log("1. Contract ABIs");
const abis: Record<string, Abi> = {};
for (const c of contracts) {
  const { abi, bin } = await c.artifact();
  abis[c.label] = abi;
  await step(`${c.label} (${c.name})`, () =>
    mb.contracts.createContract(c.label, { label: c.label, contractName: c.name, version: VERSION, rawAbi: JSON.stringify(abi), bin }),
  );
}

console.log("2. Addresses, aliases and links");
// Free the retired contract's slot first so the new link fits the five-contract cap.
await step(`unlink ${RETIRED.alias} ↔ ${RETIRED.label} (retired)`, () => mb.contracts.unlinkAddressContract(RETIRED.alias, RETIRED.label), false, true);
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
// MultiBaas needs each input field's position (inputIndex); a name alone is
// rejected. Look it up in the event's ABI so the queries read by name here.
function inputOf(label: string, event: string) {
  const entry = abis[label]?.find((e) => e.type === "event" && e.name === event.split("(")[0]);
  if (!entry || entry.type !== "event") throw new Error(`event ${event} not in ${label}'s ABI`);
  return (name: string, aggregator?: "add" | "subtract", alias?: string) => {
    const inputIndex = entry.inputs.findIndex((i) => i.name === name);
    if (inputIndex < 0) throw new Error(`${event} has no input ${name}`);
    return { type: "input" as const, name, inputIndex, alias: alias ?? name, ...(aggregator ? { aggregator } : {}) };
  };
}

const CASH_IN = "CashIn(bytes32,address,uint256,uint32,bytes3)";
const TRANSFER = "Transfer(address,address,uint256)";
const DEPOSITED = "Deposited(address,uint256,uint256)";
const WITHDRAWN = "Withdrawn(address,address,uint256,uint256)";
const ATTESTED = "ReserveAttested(bytes32,uint256,uint256,int256,bytes32)";
const PULLED = "Pulled(address,address,bytes32,address,uint256)";
const cashIn = inputOf(LABELS.cashReceipt, CASH_IN);
const transfer = inputOf(LABELS.cashReceipt, TRANSFER);
const deposited = inputOf(LABELS.vault, DEPOSITED);
const withdrawn = inputOf(LABELS.vault, WITHDRAWN);
const attested = inputOf(LABELS.cashReceipt, ATTESTED);
const pulled = inputOf(LABELS.aqua, PULLED);
// An aggregated query must name its group-by field explicitly.
const queries: Record<string, EventQuery> = {
  // Proof of reserve: USD minted per kiosk.
  cash_in_by_kiosk: {
    events: [{ eventName: CASH_IN, select: [cashIn("kioskId"), cashIn("amount", "add", "total")], filter: onlyContract(LABELS.cashReceipt) }],
    groupBy: "kioskId",
  },
  // Banknote mix: how much came in per face value.
  cash_in_by_denomination: {
    events: [{ eventName: CASH_IN, select: [cashIn("denomination"), cashIn("amount", "add", "total")], filter: onlyContract(LABELS.cashReceipt) }],
    groupBy: "denomination",
  },
  // tkCASH holders: + what each address received, − what it sent.
  tkcash_holders: {
    events: [
      { eventName: TRANSFER, select: [transfer("to", undefined, "holder"), transfer("value", "add", "balance")], filter: onlyContract(LABELS.cashReceipt) },
      { eventName: TRANSFER, select: [transfer("from", undefined, "holder"), transfer("value", "subtract", "balance")], filter: onlyContract(LABELS.cashReceipt) },
    ],
    groupBy: "holder",
  },
  // Vault principal deposited per (bound) address.
  deposits_by_user: {
    events: [{ eventName: DEPOSITED, select: [deposited("user"), deposited("usdcAmount", "add", "total")], filter: onlyContract(LABELS.vault) }],
    groupBy: "user",
  },
  // Every withdrawal, for the flows chart.
  withdrawals: {
    events: [
      {
        eventName: WITHDRAWN,
        select: [withdrawn("owner"), withdrawn("recipient"), withdrawn("usdcAmount"), { type: "triggered_at", alias: "at" }, { type: "tx_hash", alias: "txHash" }],
        filter: onlyContract(LABELS.vault),
      },
    ],
    orderBy: "at",
    order: "DESC",
  },
  // Tokens traders took out of Aqua strategies, per token (swap volume).
  aqua_pulled_by_token: {
    events: [{ eventName: PULLED, select: [pulled("token"), pulled("amount", "add", "total")], filter: onlyContract(LABELS.aqua) }],
    groupBy: "token",
  },
  // Operator counts against the chain's reserve.
  reserve_attestations: {
    events: [
      {
        eventName: ATTESTED,
        select: [attested("kioskId"), attested("counted"), attested("onChain"), attested("delta"), attested("auditRef"), { type: "triggered_at", alias: "at" }],
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

console.log("5. Existing customers");
// Accounts registered before MultiBaas was set up: allowlist their wallet
// for tkCASH and give it an alias (new accounts get both at registration).
try {
  const { rows } = await pool.query("select ens_name, privy_wallet from accounts where ens_name is not null");
  for (const a of rows as Array<{ ens_name: string; privy_wallet: string }>) {
    const alias = toAlias(a.ens_name.split(".")[0] ?? a.ens_name);
    await step(`alias ${alias} → ${a.privy_wallet}`, () => mb.addresses.setAddress({ alias, address: a.privy_wallet }), false);
    if (!config.cashReceiptAddress) continue;
    const allowed = await mbCall<boolean>(ALIASES.tkcash, LABELS.cashReceipt, "allowlist", [a.privy_wallet]).catch(() => false);
    if (allowed) console.log(`  · ${alias} allowlisted for tkCASH (already there)`);
    else await step(`allowlist ${alias} for tkCASH`, () => mbSend(ALIASES.tkcash, LABELS.cashReceipt, "setAllowlisted", [a.privy_wallet, true]), false);
  }
  if (!rows.length) console.log("  - no accounts yet");
} catch (err) {
  console.error(`  ✗ ${err instanceof Error ? err.message : err}`);
} finally {
  await pool.end();
}

console.log("Done.");
