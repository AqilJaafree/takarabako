import { pool } from "./db.js";
import { LABELS } from "./multibaas.js";

/// The contract events MultiBaas delivers by webhook, persisted in Postgres
/// (chain_events) so the dashboard feed survives a restart, plus a tiny
/// in-process fan-out for the ops monitor.

export interface StoredEvent {
  id: string;
  name: string;
  contractLabel: string | null;
  contractAddress: string | null;
  inputs: Record<string, string>;
  txHash: string | null;
  blockNumber: number | null;
  triggeredAt: Date;
}

/// One entry of a MultiBaas `event.emitted` webhook payload (an array of these).
export interface WebhookDelivery {
  id: string;
  event: string;
  data: {
    triggeredAt: string;
    event: {
      name: string;
      inputs: Array<{ name: string; value: unknown }>;
      contract: { address?: string; label?: string; name?: string };
    };
    transaction: { txHash?: string; blockNumber?: number };
  };
}

export function fromDelivery(d: WebhookDelivery): StoredEvent {
  return {
    id: d.id,
    name: d.data.event.name,
    contractLabel: d.data.event.contract.label ?? null,
    contractAddress: d.data.event.contract.address ?? null,
    inputs: Object.fromEntries(d.data.event.inputs.map((i) => [i.name, String(i.value)])),
    txHash: d.data.transaction.txHash ?? null,
    blockNumber: d.data.transaction.blockNumber ?? null,
    triggeredAt: new Date(d.data.triggeredAt),
  };
}

/// 1inch Aqua and the ENS registry are shared with the rest of Sepolia, so
/// MultiBaas delivers everyone's events for them. Keep only ours: Aqua
/// strategies whose maker is the treasury, and names the treasury registered.
export async function isOurs(e: StoredEvent, treasury: string | undefined): Promise<boolean> {
  const t = treasury?.toLowerCase();
  const is = (v: string | undefined) => Boolean(t && v?.toLowerCase() === t);
  if (e.contractLabel === LABELS.ensRegistry) return is(e.inputs.sender);
  if (e.contractLabel === LABELS.aqua) return is(e.inputs.maker);
  return true;
}

/// Returns false if this delivery was already stored (MultiBaas retries).
export async function saveEvent(e: StoredEvent): Promise<boolean> {
  const { rowCount } = await pool.query(
    `insert into chain_events (id, name, contract_label, contract_addr, inputs, tx_hash, block_number, triggered_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8) on conflict (id) do nothing`,
    [e.id, e.name, e.contractLabel, e.contractAddress, JSON.stringify(e.inputs), e.txHash, e.blockNumber, e.triggeredAt],
  );
  return (rowCount ?? 0) > 0;
}

export async function recentEvents(limit = 50): Promise<StoredEvent[]> {
  const { rows } = await pool.query(
    `select id, name, contract_label as "contractLabel", contract_addr as "contractAddress", inputs,
            tx_hash as "txHash", block_number::int as "blockNumber", triggered_at as "triggeredAt"
     from chain_events order by triggered_at desc limit $1`,
    [limit],
  );
  return rows;
}

type Listener = (e: StoredEvent) => void | Promise<void>;
const listeners: Listener[] = [];

export function onChainEvent(fn: Listener) {
  listeners.push(fn);
}

export async function emitChainEvent(e: StoredEvent) {
  for (const fn of listeners) {
    await Promise.resolve(fn(e)).catch((err) => console.error(`[events] listener failed on ${e.name}:`, err));
  }
}
