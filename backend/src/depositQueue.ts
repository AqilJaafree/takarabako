import { Queue, Worker, type Job } from "bullmq";
import type { Address } from "viem";
import { newRedisConnection } from "./redis.js";
import {
  getDeposit,
  findByPrivyUserId,
  markDepositSending,
  markDepositConfirmed,
  markDepositFailed,
} from "./accounts.js";
import { toUsd } from "./fx.js";
import { sendDepositTx, waitForDepositTx } from "./chain.js";
import { publishUserEvent, type UserEvent } from "./events.js";
import { maybeSendReceipt } from "./receiptEmail.js";

/// Durable deposits. The row in Postgres is the record; the BullMQ job is the
/// work item. If the backend dies mid-job, BullMQ's stalled-job check hands
/// the job to a worker again after restart. A stored tx_hash means "already
/// sent — only wait", so no retry can pay twice.
export const DEPOSIT_ATTEMPTS = 5;
const QUEUE_NAME = "deposits";

let queue: Queue | null = null;

function depositQueue() {
  queue ??= new Queue(QUEUE_NAME, {
    connection: newRedisConnection(),
    defaultJobOptions: {
      attempts: DEPOSIT_ATTEMPTS,
      backoff: { type: "exponential", delay: 5_000 },
      removeOnComplete: 1000,
      removeOnFail: false,
    },
  });
  return queue;
}

export async function enqueueDeposit(depositId: string) {
  // jobId = depositId: the same deposit can never be queued twice. The
  // connection retries forever, so without a timeout a Redis outage would
  // hang the request instead of failing it.
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("Redis did not answer within 3s")), 3_000);
  });
  try {
    await Promise.race([depositQueue().add("deposit", { depositId }, { jobId: depositId }), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export interface ProcessDeps {
  toUsd: (amount: number, currency: "USD" | "MYR") => Promise<{ usdAmount: number; rate: number; source: string }>;
  send: (user: Address, usdAmount: number) => Promise<`0x${string}`>;
  wait: (hash: `0x${string}`, user: Address) => Promise<number>;
  publish: (privyUserId: string, event: UserEvent) => Promise<void>;
}

const liveDeps: ProcessDeps = { toUsd, send: sendDepositTx, wait: waitForDepositTx, publish: publishUserEvent };

export async function processDeposit(depositId: string, deps: ProcessDeps = liveDeps) {
  const row = await getDeposit(depositId);
  if (!row || row.status === "confirmed" || row.status === "failed") return;
  const account = await findByPrivyUserId(row.privyUserId);
  if (!account) throw new Error(`deposit ${depositId}: account missing`);
  const user = account.boundAddress as Address;

  let hash = row.txHash as `0x${string}` | null;
  let usdAmount = row.usdAmount ?? 0;
  let rate = row.amount > 0 ? usdAmount / row.amount : 1;
  if (!hash) {
    const fx = await deps.toUsd(row.amount, row.currency as "USD" | "MYR");
    usdAmount = fx.usdAmount;
    rate = fx.rate;
    hash = await deps.send(user, usdAmount);
    await markDepositSending(depositId, hash, usdAmount); // stored before waiting
  }

  const balance = await deps.wait(hash, user);
  await markDepositConfirmed(depositId);
  await deps.publish(row.privyUserId, {
    type: "deposit.confirmed",
    depositId,
    amount: row.amount,
    currency: row.currency,
    usdAmount,
    fxRate: rate,
    txHash: hash,
    balance,
  });
  if (row.sessionId) await sendReceiptIfDone(row.sessionId);
}

// The receipt email must never fail (and so retry) a deposit that already went through.
async function sendReceiptIfDone(sessionId: string) {
  await maybeSendReceipt(sessionId).catch((err) => console.error(`[receipt] ${sessionId}:`, err));
}

export function startDepositWorker() {
  const worker = new Worker<{ depositId: string }>(QUEUE_NAME, (job: Job<{ depositId: string }>) => processDeposit(job.data.depositId), {
    connection: newRedisConnection(),
    // Sends are serialised in chain.ts anyway; one job at a time keeps the
    // receipt waits simple and the kiosk's notes in order.
    concurrency: 1,
  });

  worker.on("failed", async (job, err) => {
    if (!job) return;
    const final = job.attemptsMade >= DEPOSIT_ATTEMPTS;
    const row = await getDeposit(job.data.depositId);
    await markDepositFailed(job.data.depositId, err.message, final);
    if (!row) return;
    console.error(`[deposits] ${row.id} attempt ${job.attemptsMade}/${DEPOSIT_ATTEMPTS} failed: ${err.message}`);
    await publishUserEvent(
      row.privyUserId,
      final
        ? { type: "deposit.failed", depositId: row.id, amount: row.amount, currency: row.currency, error: err.message }
        : { type: "deposit.retrying", depositId: row.id, attempt: job.attemptsMade, maxAttempts: DEPOSIT_ATTEMPTS, error: err.message },
    );
    if (final && row.sessionId) await sendReceiptIfDone(row.sessionId);
  });

  worker.on("error", (err) => console.error("[deposits] worker error:", err.message));
  return worker;
}
