"use client";

import { useCallback } from "react";
import { usePrivy, useSendTransaction, useWallets } from "@privy-io/react-auth";

export interface PreparedTx {
  to: string;
  data: string;
  chainId: number;
}

/// Has the customer sign a transaction the backend prepared, in their own
/// Privy embedded wallet (the one their ENS name and tkCASH belong to).
/// Privy shows its confirmation sheet; returns the transaction hash.
export function useWalletSend() {
  const { ready, authenticated, login } = usePrivy();
  const { wallets } = useWallets();
  const { sendTransaction } = useSendTransaction();

  return useCallback(
    async (tx: PreparedTx, from: string, description: string): Promise<string> => {
      if (!ready) throw new Error("wallet is still loading — try again in a moment");
      if (!authenticated) {
        // The backend session outlives Privy's browser session; sign back in to Privy to sign.
        login();
        throw new Error("sign in to your wallet, then press send again");
      }
      const embedded = wallets.find((w) => w.address.toLowerCase() === from.toLowerCase());
      if (!embedded) throw new Error("your Takarabako wallet isn't available in this browser — log out and in again");
      const { hash } = await sendTransaction(
        { to: tx.to, data: tx.data, chainId: tx.chainId },
        { address: embedded.address, uiOptions: { description } },
      );
      return hash;
    },
    [ready, authenticated, login, wallets, sendTransaction],
  );
}
