/// Which chain a note is credited and its tkCASH minted on: the network the customer picked, else
/// the kiosk's home chain, else the backend's default. The note is already in the box by the time
/// this runs, so a choice that is no longer available falls back rather than refusing the deposit.
export function resolveDepositChain<T extends string>(d: {
  customer?: string | null;
  kiosk?: string | null;
  ready: readonly T[];
  fallback: T;
}): T {
  const usable = (key?: string | null) => d.ready.find((chain) => chain === key);
  return usable(d.customer) ?? usable(d.kiosk) ?? d.fallback;
}
