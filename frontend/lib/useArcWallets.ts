"use client";

import { useCallback } from "react";
import { useConnectWallet, usePrivy, useSendTransaction, useWallets } from "@privy-io/react-auth";
import { ARC_CHAIN_ID, parseChainId } from "./arcChain";
import type { PreparedTx } from "./useWalletSend";

export interface ArcWallet {
  address: string;
  /// Takarabako's own (Privy embedded) wallet, or one the customer connected (MetaMask and others).
  kind: "embedded" | "external";
  name: string;
  /// Whether the wallet is on the chain being used right now (Arc mainnet unless another was asked for).
  onArc: boolean;
}

export interface ArcWalletsApi {
  wallets: ArcWallet[];
  /// Opens Privy's connect-wallet window.
  connectExternal: () => void;
  /// Asks the wallet to switch to Arc mainnet, adding the network first if it does not know it.
  switchToArc: (address: string) => Promise<void>;
  /// Has the wallet sign and send a transaction the backend prepared, on Arc.
  sign: (tx: PreparedTx, from: string, description: string) => Promise<string>;
}

/// The customer's wallets for signing on Arc mainnet (or another chain by id, such as Sepolia for
/// testing): their Takarabako wallet and any external wallet they connect. Switching networks is
/// Privy's `switchChain`: it asks the wallet to switch and, if the wallet does not have the chain,
/// adds it first.
export function useArcWallets(chainId: number = ARC_CHAIN_ID): ArcWalletsApi {
  const { ready, authenticated, login } = usePrivy();
  const { wallets } = useWallets();
  const { connectWallet } = useConnectWallet();
  const { sendTransaction } = useSendTransaction();

  const list: ArcWallet[] = wallets.map((w) => ({
    address: w.address,
    kind: w.walletClientType === "privy" ? "embedded" : "external",
    name: w.walletClientType === "privy" ? "Takarabako wallet" : (w.meta?.name ?? w.walletClientType),
    onArc: parseChainId(w.chainId) === chainId,
  }));

  const find = useCallback(
    (address: string) => {
      const w = wallets.find((x) => x.address.toLowerCase() === address.toLowerCase());
      if (!w) throw new Error("that wallet is not connected in this browser: connect it, or log out and in again");
      return w;
    },
    [wallets],
  );

  const switchToArc = useCallback(async (address: string) => {
    await find(address).switchChain(chainId);
  }, [find, chainId]);

  const sign = useCallback(
    async (tx: PreparedTx, from: string, description: string) => {
      if (!ready) throw new Error("wallet is still loading — try again in a moment");
      if (!authenticated) {
        login();
        throw new Error("sign in to your wallet, then try again");
      }
      const w = find(from);
      if (parseChainId(w.chainId) !== chainId) await w.switchChain(chainId);
      const { hash } = await sendTransaction(
        {
          to: tx.to,
          data: tx.data,
          chainId: tx.chainId,
          ...(tx.maxFeePerGas ? { maxFeePerGas: tx.maxFeePerGas } : {}),
          ...(tx.maxPriorityFeePerGas ? { maxPriorityFeePerGas: tx.maxPriorityFeePerGas } : {}),
        },
        { address: w.address, uiOptions: { description } },
      );
      return hash;
    },
    [ready, authenticated, login, find, sendTransaction, chainId],
  );

  return { wallets: list, connectExternal: () => connectWallet(), switchToArc, sign };
}
