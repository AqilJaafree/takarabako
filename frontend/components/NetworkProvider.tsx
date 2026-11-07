"use client";

import { createContext, useCallback, useContext, useMemo, useState } from "react";
import { NETWORK_COOKIE, type DepositChainInfo, type NetworkKey, type NetworksResponse } from "@/lib/networks";

interface NetworkContextValue {
  networks: NetworksResponse;
  view: NetworkKey;
  setView: (key: NetworkKey) => void;
  /// Where the customer's next note is credited and its tkCASH minted (null = couldn't be read).
  depositChain: NetworkKey | null;
}

const NetworkContext = createContext<NetworkContextValue | null>(null);

/// The network picked in the top bar, shared by every signed-in page and remembered in a cookie so
/// the server renders the same choice. Picking a network that takes deposits also makes it where
/// the customer's notes mint. `networks` is null when the backend couldn't list them: the switch is
/// hidden and pages fall back to their own defaults.
export function NetworkProvider({
  networks,
  initial,
  deposit,
  children,
}: {
  networks: NetworksResponse | null;
  initial: NetworkKey | null;
  deposit: DepositChainInfo | null;
  children: React.ReactNode;
}) {
  const [view, setChosen] = useState(initial);
  const [depositChain, setDepositChain] = useState(deposit?.chain ?? null);
  const setView = useCallback((key: NetworkKey) => {
    setChosen(key);
    document.cookie = `${NETWORK_COOKIE}=${key}; path=/; max-age=31536000; samesite=lax`;
    // Arc mainnet has no box, so a note can't go there: it keeps going where it was going.
    if (key === "arc") return;
    fetch("/api/me/deposit-chain", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chain: key }) })
      .then((res) => res.json() as Promise<Partial<DepositChainInfo>>)
      .then((info) => info.chain && setDepositChain(info.chain))
      .catch(() => setDepositChain(null));
  }, []);
  const value = useMemo(
    () => (networks && view ? { networks, view, setView, depositChain } : null),
    [networks, view, setView, depositChain],
  );
  return <NetworkContext.Provider value={value}>{children}</NetworkContext.Provider>;
}

export function useNetwork(): NetworkContextValue | null {
  return useContext(NetworkContext);
}

/// A chain picker for a page that only works on some chains: it follows the top bar's network when
/// that is one of them, keeps its own choice otherwise, and picking one moves the top bar too.
export function useChainPick<T extends NetworkKey>(available: readonly T[], fallback: T): [T, (key: T) => void] {
  const network = useNetwork();
  const [own, setOwn] = useState(fallback);
  const followed = available.find((key) => key === network?.view);
  const pick = useCallback(
    (key: T) => {
      setOwn(key);
      network?.setView(key);
    },
    [network],
  );
  return [followed ?? own, pick];
}

/// The network switch in the top bar, next to Log out.
export function NetworkSelect() {
  const network = useNetwork();
  if (!network) return null;
  return (
    <select
      className="net-select"
      aria-label="Network"
      value={network.view}
      onChange={(e) => network.setView(e.target.value as NetworkKey)}
    >
      {network.networks.networks.map((n) => (
        <option key={n.key} value={n.key}>
          {n.real ? `${n.name} · real money` : n.name}
        </option>
      ))}
    </select>
  );
}
