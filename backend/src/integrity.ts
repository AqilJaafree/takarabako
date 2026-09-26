import { pool } from "./db.js";
import { config } from "./config.js";
import { cashReceiptReady, kioskState, knownKioskIds } from "./cashReceipt.js";
import { reserveAttestations, decodeKiosk } from "./treasury.js";

/// Cash integrity: three independent records of the cash in a kiosk's box
/// should always agree —
///   1. the machine: every note the kiosk took, signed by its device key
///      (deposits.machine_verified, machine.ts);
///   2. the chain: every tkCASH CashIn minted against that kiosk
///      (chain_events, streamed by the MultiBaas webhook);
///   3. the operator: physical counts recorded on-chain (ReserveAttested).
/// A mint with no signed note, a signed note that never minted, or a count
/// that comes up short each point at a different failure: fake deposits,
/// a stuck mint, or cash leaving the box. The rules below are plain code;
/// the treasury agent explains the findings and acts on them.

export const INTEGRITY = {
  windowDays: 7,
  mintLagMinutes: 10, // a confirmed note should have minted by now
  staleCountDays: 3, // a kiosk holding cash should be counted at least this often
} as const;

export type Severity = "critical" | "warn" | "info";

export interface Finding {
  code: "count_short" | "count_over" | "mint_without_signed_note" | "note_not_minted" | "unsigned_notes" | "never_counted" | "stale_count" | "kiosk_frozen";
  severity: Severity;
  title: string;
  detail: string;
}

export interface NoteRecord {
  id: string;
  usd: number;
  signed: boolean;
  status: string;
  mintTx: string | null;
  at: string;
}

export interface MintRecord {
  txHash: string | null;
  usd: number;
  at: string;
}

export interface CountRecord {
  counted: number;
  onChain: number;
  delta: number;
  at: string | null;
}

export interface IntegrityInput {
  kioskId: string;
  reserve: number | null;
  frozen: boolean;
  notes: NoteRecord[]; // this kiosk's notes in the window
  mints: MintRecord[]; // this kiosk's CashIn events in the window
  counts: CountRecord[]; // newest first
  now?: number;
}

export interface IntegrityReport {
  kioskId: string;
  windowDays: number;
  status: "clear" | "warn" | "critical";
  machine: { notes: number; usd: number; unsigned: number };
  chain: { mints: number; usd: number; reserve: number | null; frozen: boolean };
  lastCount: CountRecord | null;
  notesSinceCount: number;
  findings: Finding[];
  checkedAt: string;
}

const money = (n: number) => `$${Math.abs(n).toFixed(2)}`;
const sum = (xs: Array<{ usd: number }>) => xs.reduce((s, x) => s + x.usd, 0);

/// The rules. Pure, so it's testable without a database or chain.
export function reconcile(input: IntegrityInput): IntegrityReport {
  const now = input.now ?? Date.now();
  const findings: Finding[] = [];
  const lastCount = input.counts[0] ?? null;

  // 3. The operator's count against the chain.
  if (lastCount && lastCount.delta < 0) {
    findings.push({
      code: "count_short",
      severity: "critical",
      title: `Count came up ${money(lastCount.delta)} short`,
      detail: `The box was counted at ${money(lastCount.counted)} but the chain says ${money(lastCount.onChain)} was deposited: cash left the box after it was credited.`,
    });
  } else if (lastCount && lastCount.delta > 0) {
    findings.push({
      code: "count_over",
      severity: "warn",
      title: `Count came up ${money(lastCount.delta)} over`,
      detail: `The box held ${money(lastCount.counted)} but only ${money(lastCount.onChain)} was minted: a note may have been taken without being credited.`,
    });
  }

  // 2 vs 1. Every mint should belong to a note the machine signed.
  const signedMintTxs = new Set(input.notes.filter((n) => n.signed && n.mintTx).map((n) => n.mintTx!.toLowerCase()));
  const unbacked = input.mints.filter((m) => !m.txHash || !signedMintTxs.has(m.txHash.toLowerCase()));
  if (unbacked.length > 0) {
    findings.push({
      code: "mint_without_signed_note",
      severity: "critical",
      title: `${unbacked.length} mint${unbacked.length > 1 ? "s" : ""} with no machine-signed note`,
      detail: `${money(sum(unbacked))} of tkCASH was minted against this kiosk without a note signed by its device key: deposits that didn't come from the box.`,
    });
  }

  // 1 vs 2. Every confirmed note should have minted.
  const lagMs = INTEGRITY.mintLagMinutes * 60_000;
  const stuck = input.notes.filter((n) => n.status === "confirmed" && !n.mintTx && now - Date.parse(n.at) > lagMs);
  if (stuck.length > 0) {
    findings.push({
      code: "note_not_minted",
      severity: "warn",
      title: `${stuck.length} note${stuck.length > 1 ? "s" : ""} credited but not minted`,
      detail: `${money(sum(stuck))} was credited to customers but no tkCASH was minted for it, so the box holds cash the chain doesn't know about.`,
    });
  }

  const unsigned = input.notes.filter((n) => !n.signed);
  if (unsigned.length > 0) {
    findings.push({
      code: "unsigned_notes",
      severity: "warn",
      title: `${unsigned.length} note${unsigned.length > 1 ? "s" : ""} without a machine signature`,
      detail: `${money(sum(unsigned))} came in without the kiosk's device signature, so it can't be proven the notes came from this box.`,
    });
  }

  // Counting discipline.
  const reserve = input.reserve ?? 0;
  if (!lastCount && reserve > 0) {
    findings.push({
      code: "never_counted",
      severity: "warn",
      title: "Never counted",
      detail: `The chain says this box holds ${money(reserve)}, but no operator has counted it yet.`,
    });
  } else if (lastCount?.at && reserve > 0 && now - Date.parse(lastCount.at) > INTEGRITY.staleCountDays * 86_400_000) {
    const days = Math.floor((now - Date.parse(lastCount.at)) / 86_400_000);
    findings.push({
      code: "stale_count",
      severity: "info",
      title: `Last counted ${days} days ago`,
      detail: `Count the box at least every ${INTEGRITY.staleCountDays} days while it holds cash (${money(reserve)} now).`,
    });
  }

  if (input.frozen) {
    findings.push({
      code: "kiosk_frozen",
      severity: "critical",
      title: "Minting frozen",
      detail: "The contract froze this kiosk after a count mismatch. It stays frozen until a human clears it.",
    });
  }

  const notesSinceCount = lastCount?.at ? input.notes.filter((n) => Date.parse(n.at) > Date.parse(lastCount.at!)).length : input.notes.length;
  const status = findings.some((f) => f.severity === "critical") ? "critical" : findings.some((f) => f.severity === "warn") ? "warn" : "clear";
  return {
    kioskId: input.kioskId,
    windowDays: INTEGRITY.windowDays,
    status,
    machine: { notes: input.notes.length, usd: sum(input.notes), unsigned: unsigned.length },
    chain: { mints: input.mints.length, usd: sum(input.mints), reserve: input.reserve, frozen: input.frozen },
    lastCount,
    notesSinceCount,
    findings,
    checkedAt: new Date(now).toISOString(),
  };
}

/// Gathers the three records for one kiosk and runs the rules.
export async function checkKiosk(kioskId: string): Promise<IntegrityReport> {
  const since = new Date(Date.now() - INTEGRITY.windowDays * 86_400_000);
  const machineName = `${kioskId}.${config.ens.parentName}`;
  // Notes signed by this kiosk; unsigned notes are attributed to the current
  // kiosk, since that's the one the backend mints against.
  const notesQ = pool.query(
    `select id, coalesce(usd_amount, 0)::float as usd, machine_verified as signed, status, tkcash_tx_hash as "mintTx", created_at as at
       from deposits
      where created_at >= $1 and status <> 'failed'
        and (machine_name = $2 or (machine_name is null and $3))`,
    [since, machineName, kioskId === config.kioskId],
  );
  const mintsQ = pool.query(
    `select tx_hash as "txHash", inputs, triggered_at as at from chain_events where name = 'CashIn' and triggered_at >= $1`,
    [since],
  );
  const [notes, mints, attestations, state] = await Promise.all([
    notesQ,
    mintsQ,
    reserveAttestations(50).catch(() => []),
    cashReceiptReady ? kioskState(kioskId).catch(() => null) : Promise.resolve(null),
  ]);
  return reconcile({
    kioskId,
    reserve: state?.reserve ?? null,
    frozen: Boolean(state?.frozen),
    notes: notes.rows.map((r) => ({ ...r, at: new Date(r.at).toISOString() })),
    mints: mints.rows
      .filter((r) => decodeKiosk(r.inputs?.kioskId) === kioskId)
      .map((r) => ({ txHash: r.txHash, usd: Number(r.inputs?.amount ?? 0) / 1e6, at: new Date(r.at).toISOString() })),
    counts: attestations.filter((a) => a.kioskId === kioskId),
  });
}

export async function checkAllKiosks(): Promise<IntegrityReport[]> {
  return Promise.all(knownKioskIds().map((id) => checkKiosk(id)));
}
