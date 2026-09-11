import { createPublicClient, createWalletClient, http, parseAbi, parseUnits, formatUnits, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { config } from "./config.js";

/// Phase 1 (PRD §7.3/§7.4): real on-chain calls into the deployed
/// TakarabakoVault + MockUSDC on Ethereum Sepolia, signed by the backend's
/// treasury key (env-injected, never on the Pi — PRD §10).

const vaultAbi = parseAbi([
  "function depositFor(address user, uint256 usdcAmount) returns (uint256 shares)",
  "function withdrawTo(address owner, address recipient, uint256 shares) returns (uint256 usdcAmount)",
  "function sharesOf(address user) view returns (uint256)",
  "function previewValue(address user) view returns (uint256 usdcValue)",
  "function currentApyBps() view returns (uint256)",
]);

// USDC uses 6 decimals, not the usual 18 — see contracts/src/mocks/MockUSDC.sol.
const USDC_DECIMALS = 6;

const account = config.treasuryPrivateKey ? privateKeyToAccount(config.treasuryPrivateKey as `0x${string}`) : undefined;

export const chainReady = Boolean(account && config.usdcAddress && config.vaultAddress);
export const treasuryAddress = account?.address;

const publicClient = createPublicClient({
  chain: sepolia,
  transport: http(config.rpcUrl),
});

const walletClient = account
  ? createWalletClient({
      account,
      chain: sepolia,
      transport: http(config.rpcUrl),
    })
  : undefined;

function vaultAddress(): Address {
  return config.vaultAddress as Address;
}

/// Fronts `amount` (demo units, e.g. 1000 == "$1,000") from the treasury into
/// the vault on behalf of `user`, returns the tx hash and `user`'s live
/// on-chain value (principal — yield hasn't had time to accrue yet).
export async function depositOnChain(user: Address, amount: number) {
  if (!walletClient) throw new Error("chain not configured — set TREASURY_PRIVATE_KEY/USDC_ADDRESS/VAULT_ADDRESS");
  const raw = parseUnits(amount.toString(), USDC_DECIMALS);

  const hash = await walletClient.writeContract({
    address: vaultAddress(),
    abi: vaultAbi,
    functionName: "depositFor",
    args: [user, raw],
  });
  await publicClient.waitForTransactionReceipt({ hash });

  const value = await previewValueOnChain(user);
  return { txHash: hash, value };
}

/// Redeems every vault share `user` holds, sending principal + accrued
/// yield to `recipient` (the dev/treasury wallet on withdraw — PRD §6.6).
export async function withdrawAllOnChain(user: Address, recipient: Address) {
  if (!walletClient) throw new Error("chain not configured — set TREASURY_PRIVATE_KEY/USDC_ADDRESS/VAULT_ADDRESS");

  const shares = await publicClient.readContract({
    address: vaultAddress(),
    abi: vaultAbi,
    functionName: "sharesOf",
    args: [user],
  });
  if (shares === 0n) return { txHash: null, amount: 0 };

  // Read the value (principal + accrued yield, at the current exchange
  // rate) before burning the shares — withdrawTo's return value isn't
  // decodable from the tx receipt without an event, and this backend is
  // the only signer, so no other tx can move the rate between these calls.
  const amount = await previewValueOnChain(user);

  const hash = await walletClient.writeContract({
    address: vaultAddress(),
    abi: vaultAbi,
    functionName: "withdrawTo",
    args: [user, recipient, shares],
  });
  await publicClient.waitForTransactionReceipt({ hash });

  return { txHash: hash, amount };
}

export async function previewValueOnChain(user: Address): Promise<number> {
  const value = await publicClient.readContract({
    address: vaultAddress(),
    abi: vaultAbi,
    functionName: "previewValue",
    args: [user],
  });
  return Number(formatUnits(value, USDC_DECIMALS));
}

export async function currentApyBpsOnChain(): Promise<number> {
  const bps = await publicClient.readContract({
    address: vaultAddress(),
    abi: vaultAbi,
    functionName: "currentApyBps",
  });
  return Number(bps);
}
