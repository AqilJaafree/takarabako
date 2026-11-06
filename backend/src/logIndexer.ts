import { parseAbi, type Log } from "viem";
import { config, type CashChainKey } from "./config.js";
import { pool } from "./db.js";
import { chainOps } from "./chain.js";
import { emitChainEvent, saveEvent, type StoredEvent } from "./chainEvents.js";
import { LABELS, multibaasReady } from "./multibaas.js";

/// Event indexing for the chains MultiBaas doesn't cover (Arc Testnet): the
/// vault's and tkCASH's logs are read straight from the chain's RPC into the
/// same `chain_events` table the MultiBaas webhook fills, with the same
/// labels and input names, so the dashboard, the ops monitor and the proof of
/// reserve treat both chains alike.
///
/// Cold start: never from block 0. With no saved cursor it starts at
/// <CHAIN>_INDEX_FROM_BLOCK (set it to the contracts' deployment block for a
/// full history), otherwise at the chain head minus LOOKBACK_BLOCKS. It then
/// moves forward in bounded batches and saves its place after each one.

const LOOKBACK_BLOCKS = 5_000n;
const POLL_MS = 15_000;

const vaultEvents = parseAbi([
  "event Deposited(address indexed user, uint256 usdcAmount, uint256 shares)",
  "event Withdrawn(address indexed owner, address indexed recipient, uint256 shares, uint256 usdcAmount)",
  "event ApyUpdated(uint256 newApyBps)",
  "event YieldReserveFunded(uint256 amount)",
]);
const tkEvents = parseAbi([
  "event KioskUpdated(bytes32 indexed kioskId, bool active)",
  "event CashIn(bytes32 indexed kioskId, address indexed user, uint256 amount, uint32 denomination, bytes3 currency)",
  "event CashOut(bytes32 indexed kioskId, address indexed user, uint256 amount)",
  "event ReserveAttested(bytes32 indexed kioskId, uint256 counted, uint256 onChain, int256 delta, bytes32 auditRef)",
  "event KioskFrozen(bytes32 indexed kioskId, int256 delta)",
  "event KioskUnfrozen(bytes32 indexed kioskId)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);

/// Chains that need this indexer: every enabled chain except the one MultiBaas serves.
export function indexedChains(): CashChainKey[] {
  return config.enabledChains.filter((k) => !(multibaasReady && k === config.defaultChain));
}

export interface IndexerStatus {
  chain: CashChainKey;
  head: number | null;
  cursor: number | null;
  behind: number | null;
  live: boolean;
}

async function getCursor(chain: CashChainKey, contract: string): Promise<bigint | null> {
  const { rows } = await pool.query("select last_block from indexer_cursors where chain = $1 and contract = $2", [chain, contract.toLowerCase()]);
  return rows[0] ? BigInt(rows[0].last_block) : null;
}

async function setCursor(chain: CashChainKey, contract: string, block: bigint) {
  await pool.query(
    `insert into indexer_cursors (chain, contract, last_block) values ($1, $2, $3)
     on conflict (chain, contract) do update set last_block = excluded.last_block, updated_at = now()`,
    [chain, contract.toLowerCase(), block.toString()],
  );
}

const asInputs = (args: unknown): Record<string, string> =>
  Object.fromEntries(Object.entries((args ?? {}) as Record<string, unknown>).map(([k, v]) => [k, String(v)]));

async function toStored(chain: CashChainKey, label: string, log: Log, name: string, args: unknown): Promise<StoredEvent> {
  const block = await chainOps(chain).publicClient.getBlock({ blockNumber: log.blockNumber! });
  return {
    id: `${chain}:${log.transactionHash}:${log.logIndex}`,
    name,
    contractLabel: label,
    contractAddress: log.address,
    inputs: asInputs(args),
    txHash: log.transactionHash,
    blockNumber: Number(log.blockNumber),
    triggeredAt: new Date(Number(block.timestamp) * 1000),
    chain,
  };
}

/// One pass over one contract; returns how many new events were stored.
async function scan(chain: CashChainKey, label: string, address: string, abi: typeof vaultEvents | typeof tkEvents): Promise<number> {
  const client = chainOps(chain).publicClient;
  const head = await client.getBlockNumber();
  const saved = await getCursor(chain, address);
  const configured = config.chains[chain].indexFromBlock;
  const lookback = head > LOOKBACK_BLOCKS ? head - LOOKBACK_BLOCKS : 0n;
  let from: bigint = saved !== null ? saved + 1n : configured ? BigInt(configured) : lookback;
  let stored = 0;
  const batch = config.chains[chain].network.logBatchBlocks;
  while (from <= head) {
    const to: bigint = from + batch - 1n < head ? from + batch - 1n : head;
    const logs = await client.getLogs({ address: address as `0x${string}`, events: abi as never, fromBlock: from, toBlock: to });
    for (const log of logs as Array<Log & { eventName?: string; args?: unknown }>) {
      if (!log.eventName) continue;
      const event = await toStored(chain, label, log, log.eventName, log.args);
      if (await saveEvent(event)) {
        stored++;
        await emitChainEvent(event);
      }
    }
    await setCursor(chain, address, to);
    from = to + 1n;
  }
  return stored;
}

export async function indexChainOnce(chain: CashChainKey): Promise<number> {
  const c = config.chains[chain];
  let n = 0;
  if (c.vaultAddress) n += await scan(chain, LABELS.vault, c.vaultAddress, vaultEvents);
  if (c.cashReceiptAddress) n += await scan(chain, LABELS.cashReceipt, c.cashReceiptAddress, tkEvents);
  return n;
}

/// How far behind the chain head each indexed chain is, as numbers.
export async function indexerStatus(): Promise<IndexerStatus[]> {
  return Promise.all(
    indexedChains().map(async (chain) => {
      try {
        const head = Number(await chainOps(chain).publicClient.getBlockNumber());
        const addr = config.chains[chain].cashReceiptAddress || config.chains[chain].vaultAddress;
        const cursor = addr ? await getCursor(chain, addr) : null;
        const behind = cursor === null ? null : Math.max(0, head - Number(cursor));
        return { chain, head, cursor: cursor === null ? null : Number(cursor), behind, live: behind !== null && behind < 50 };
      } catch {
        return { chain, head: null, cursor: null, behind: null, live: false };
      }
    }),
  );
}

export function startLogIndexers() {
  for (const chain of indexedChains()) {
    const c = config.chains[chain];
    if (!c.vaultAddress && !c.cashReceiptAddress) {
      console.log(`[indexer] ${chain}: no contracts configured, not indexing`);
      continue;
    }
    let running = false;
    const tick = async () => {
      if (running) return;
      running = true;
      try {
        const n = await indexChainOnce(chain);
        if (n) console.log(`[indexer] ${chain}: stored ${n} event(s)`);
      } catch (err) {
        console.error(`[indexer] ${chain}:`, err instanceof Error ? err.message : err);
      } finally {
        running = false;
      }
    };
    void tick();
    setInterval(tick, POLL_MS).unref();
  }
}
