import {
  AddressesApi,
  ChainsApi,
  Configuration,
  ContractsApi,
  EventQueriesApi,
  EventsApi,
  WebhooksApi,
  type EventQuery,
  type TransactionToSignTx,
} from "@curvegrid/multibaas-sdk";
import { config } from "./config.js";
import { queueTreasurySend, resetTreasuryNonce, signTreasuryTx, treasuryAddress, waitForTx } from "./chain.js";

/// Curvegrid MultiBaas: the backend's contract layer and indexer.
///   - reads (mbCall) and treasury writes (mbSend) go through MultiBaas's
///     contract API: it encodes the call from the uploaded ABI and returns an
///     unsigned transaction, which we sign locally with the treasury key and
///     hand back to MultiBaas to broadcast. The key never leaves the backend,
///     and we don't need a Cloud Wallet (free tier: one, Azure only).
///   - MultiBaas indexes every event of the linked contracts; the dashboard
///     reads them through saved Event Queries (mbQuery) and the webhook
///     (routes/webhooks.ts) streams them in as they're mined.
/// Everything here is optional: without MULTIBAAS_URL/MULTIBAAS_API_KEY,
/// multibaasReady is false and callers fall back (like agent.ts does
/// without an Anthropic key).

export const multibaasReady = Boolean(config.multibaas.url && config.multibaas.apiKey);

/// Contract labels in MultiBaas (scripts/multibaas-setup.ts uploads them).
/// Five linked contracts is the free tier's cap.
export const LABELS = {
  vault: "takarabako_vault",
  cashReceipt: "takarabako_cash_receipt",
  usdc: "mock_usdc",
  uniswapNpm: "uniswap_v3_npm",
  ensRegistry: "ens_user_registry",
} as const;

/// Address aliases, so calls read as "vault" rather than a hex address.
export const ALIASES = { vault: "vault", tkcash: "tkcash", musdc: "musdc", treasury: "treasury" } as const;

const sdkConfig = new Configuration({
  basePath: `${config.multibaas.url}/api/v0`,
  accessToken: config.multibaas.apiKey,
});

export const mb = {
  contracts: new ContractsApi(sdkConfig),
  events: new EventsApi(sdkConfig),
  queries: new EventQueriesApi(sdkConfig),
  addresses: new AddressesApi(sdkConfig),
  chains: new ChainsApi(sdkConfig),
  webhooks: new WebhooksApi(sdkConfig),
};

function requireReady() {
  if (!multibaasReady) throw new Error("MultiBaas not configured — set MULTIBAAS_URL and MULTIBAAS_API_KEY");
}

/// MultiBaas answers errors with { status, message }; surface that message.
export function mbError(err: unknown): Error {
  const response = (err as { response?: { status?: number; data?: { message?: string } } })?.response;
  if (response) return new Error(`MultiBaas ${response.status ?? "?"}: ${response.data?.message ?? (err as Error).message}`);
  const code = (err as { code?: string })?.code;
  if (code) return new Error(`MultiBaas unreachable (${code})`); // network error: no response at all
  return err instanceof Error ? err : new Error(String(err));
}

/// Retries a call that never got an answer (DNS hiccup, timeout, reset) —
/// seen against the hosted deployment. An HTTP error response is final, and
/// nothing that broadcasts a transaction goes through here.
async function retryNetwork<T>(run: () => Promise<T>, attempts = 3): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await run();
    } catch (err) {
      const noResponse = !(err as { response?: unknown })?.response && Boolean((err as { code?: string })?.code);
      if (!noResponse || i >= attempts) throw err;
      await new Promise((r) => setTimeout(r, 500 * i));
    }
  }
}

/// A view call. Numbers come back as decimal strings (formatInts: "as_strings"),
/// so 6-decimal USDC amounts never lose precision in a JS number.
export async function mbCall<T = unknown>(addressOrAlias: string, label: string, method: string, args: unknown[] = []): Promise<T> {
  requireReady();
  try {
    const { data } = await retryNetwork(() =>
      mb.contracts.callContractFunction(addressOrAlias, label, method, { args, formatInts: "as_strings" }),
    );
    const result = data.result as { kind: string; output?: unknown };
    if (result.kind !== "MethodCallResponse") throw new Error(`${method} is not a view function`);
    return result.output as T;
  } catch (err) {
    throw mbError(err);
  }
}

/// A treasury write: MultiBaas builds it, we sign it, MultiBaas broadcasts
/// it, and we wait for it to be mined. Serialised with the viem sends in
/// chain.ts so the two paths never race for a nonce.
export async function mbSend(addressOrAlias: string, label: string, method: string, args: unknown[] = []): Promise<`0x${string}`> {
  requireReady();
  if (!treasuryAddress) throw new Error("chain not configured — set TREASURY_PRIVATE_KEY");
  const hash = await queueTreasurySend(async () => {
    let tx: TransactionToSignTx;
    try {
      // Building the transaction has no side effects, so it may be retried.
      const { data } = await retryNetwork(() =>
        mb.contracts.callContractFunction(addressOrAlias, label, method, { args, from: treasuryAddress, formatInts: "as_strings" }),
      );
      const result = data.result as { kind: string; tx?: TransactionToSignTx };
      if (result.kind !== "TransactionToSignResponse" || !result.tx) throw new Error(`${method} did not return a transaction`);
      tx = result.tx;
    } catch (err) {
      throw mbError(err);
    }

    const signedTx = await signTreasuryTx(tx);
    try {
      const { data } = await mb.chains.submitSignedTransaction({ signedTx });
      return data.result.tx.hash as `0x${string}`;
    } catch (err) {
      resetTreasuryNonce(); // the nonce wasn't used
      throw mbError(err);
    }
  });
  await waitForTx(hash);
  return hash;
}

/// MultiBaas returns at most 50 rows per request (a larger `limit` is a bare
/// 400 "invalid request"), so longer results are read page by page.
export const MB_PAGE = 50;

async function paged<Row>(fetchPage: (offset: number, limit: number) => Promise<Row[]>, limit: number): Promise<Row[]> {
  const rows: Row[] = [];
  while (rows.length < limit) {
    const want = Math.min(MB_PAGE, limit - rows.length);
    const page = await fetchPage(rows.length, want);
    rows.push(...page);
    if (page.length < want) break;
  }
  return rows;
}

/// Runs a saved Event Query (created by scripts/multibaas-setup.ts).
export async function mbQuery<Row = Record<string, unknown>>(name: string, limit = 500): Promise<Row[]> {
  requireReady();
  try {
    return await paged(async (offset, n) => {
      const { data } = await retryNetwork(() => mb.queries.executeEventQuery(name, offset, n));
      return (data.result as { rows: Row[] }).rows;
    }, limit);
  } catch (err) {
    throw mbError(err);
  }
}

/// Runs an ad-hoc Event Query without saving it.
export async function mbArbitraryQuery<Row = Record<string, unknown>>(query: EventQuery, limit = 500): Promise<Row[]> {
  requireReady();
  try {
    return await paged(async (offset, n) => {
      const { data } = await retryNetwork(() => mb.queries.executeArbitraryEventQuery(query, offset, n));
      return (data.result as { rows: Row[] }).rows;
    }, limit);
  } catch (err) {
    throw mbError(err);
  }
}

export interface ChainEvent {
  name: string;
  contractLabel: string;
  contractAddress: string;
  inputs: Record<string, string>;
  txHash: string;
  blockNumber?: number;
  triggeredAt: string;
}

/// Recent indexed events, newest first, optionally for one contract.
export async function mbEvents(opts: { contractLabel?: string; limit?: number } = {}): Promise<ChainEvent[]> {
  requireReady();
  try {
    const { data } = await mb.events.listEvents(
      undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      opts.contractLabel, undefined, Math.min(opts.limit ?? MB_PAGE, MB_PAGE),
    );
    return (data.result as Array<{
      triggeredAt: string;
      event: { name: string; inputs: Array<{ name: string; value: unknown }>; contract: { label: string; address: string } };
      transaction: { txHash: string; blockNumber?: number };
    }>).map((e) => ({
      name: e.event.name,
      contractLabel: e.event.contract.label,
      contractAddress: e.event.contract.address,
      inputs: Object.fromEntries(e.event.inputs.map((i) => [i.name, String(i.value)])),
      txHash: e.transaction.txHash,
      blockNumber: e.transaction.blockNumber,
      triggeredAt: e.triggeredAt,
    }));
  } catch (err) {
    throw mbError(err);
  }
}

/// Creates or moves an address alias (e.g. a customer's ENS label → their wallet).
export async function mbSetAlias(alias: string, address: string) {
  requireReady();
  try {
    await mb.addresses.setAddress({ alias, address });
  } catch (err) {
    throw mbError(err);
  }
}

/// MultiBaas aliases are lowercase letters, digits, hyphens and underscores.
export function toAlias(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9_-]/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
}
