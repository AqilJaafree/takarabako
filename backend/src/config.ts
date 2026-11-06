import { NETWORKS, resolveAquaDeployment, resolveNetwork, showApyEstimates, type Network, type NetworkKey } from "./networks.js";

// CHAIN picks the primary network: sepolia (default), arc-testnet, hedera-testnet or arc (mainnet).
// The primary chain is where 1inch Aqua yield runs and where the legacy,
// unprefixed variables (RPC_URL, USDC_ADDRESS, VAULT_ADDRESS, CASH_RECEIPT_ADDRESS)
// apply. Takarabako itself runs on every chain in ENABLED_CHAINS at once.
const network = resolveNetwork(process.env.CHAIN);

/// Chains the cash-in flow (vault + tkCASH) can run on.
export const CASH_CHAIN_KEYS = ["sepolia", "arc-testnet", "hedera-testnet"] as const;
export type CashChainKey = (typeof CASH_CHAIN_KEYS)[number];
export const isCashChain = (k: string): k is CashChainKey => (CASH_CHAIN_KEYS as readonly string[]).includes(k);

export interface ChainConfig {
  key: CashChainKey;
  network: Network;
  rpcUrl: string;
  usdcAddress: string;
  vaultAddress: string;
  cashReceiptAddress: string;
  /// First block to index from when the log indexer starts cold ("" = recent head).
  indexFromBlock: string;
}

/// SEPOLIA_* / ARC_TESTNET_* / HEDERA_TESTNET_* variables win; the unprefixed ones fill in for the primary chain.
function chainConfig(key: CashChainKey): ChainConfig {
  const net = NETWORKS[key as NetworkKey];
  const prefix = key.toUpperCase().replace(/-/g, "_");
  const legacy = (name: string) => (net.key === network.key ? process.env[name] : undefined);
  const pick = (suffix: string, legacyName: string) => process.env[`${prefix}_${suffix}`] || legacy(legacyName) || "";
  return {
    key,
    network: net,
    rpcUrl: pick("RPC_URL", "RPC_URL") || net.defaultRpcUrl,
    usdcAddress: pick("USDC_ADDRESS", "USDC_ADDRESS") || net.defaults.usdc,
    vaultAddress: pick("VAULT_ADDRESS", "VAULT_ADDRESS"),
    cashReceiptAddress: pick("CASH_RECEIPT_ADDRESS", "CASH_RECEIPT_ADDRESS"),
    indexFromBlock: process.env[`${prefix}_INDEX_FROM_BLOCK`] ?? "",
  };
}

const chains: Record<CashChainKey, ChainConfig> = {
  sepolia: chainConfig("sepolia"),
  "arc-testnet": chainConfig("arc-testnet"),
  "hedera-testnet": chainConfig("hedera-testnet"),
};
/// The primary chain's resolved settings (prefixed variables win over the unprefixed ones), when it is a cash chain.
const primaryCfg = isCashChain(network.key) ? chains[network.key] : null;
const enabledChains = (process.env.ENABLED_CHAINS ?? "sepolia,arc-testnet")
  .split(",")
  .map((s) => s.trim())
  .filter(isCashChain);
const aquaDeployment = resolveAquaDeployment(network.chain.id, {
  aqua: process.env.AQUA_ADDRESS,
  router: process.env.AQUA_ROUTER_ADDRESS,
});

export const config = {
  port: Number(process.env.PORT ?? 4000),
  network,
  chains,
  enabledChains: (enabledChains.length ? enabledChains : [network.key as CashChainKey].filter(isCashChain)) as readonly CashChainKey[],
  /// Where a deposit lands when the kiosk that took it has no registered home chain.
  defaultChain: (isCashChain(network.key) ? network.key : "sepolia") as CashChainKey,
  /// CCTP bridge between the cash chains (bridge.ts).
  bridge: {
    maxUsd: Number(process.env.BRIDGE_MAX_USD ?? 1000),
    attestationUrl: (process.env.CCTP_ATTESTATION_URL ?? "https://iris-api-sandbox.circle.com").replace(/\/+$/, ""),
  },
  // Self-custody positions on Arc mainnet (selfPositions.ts): the customer signs with
  // their own wallet. Real money, so off unless SELF_CUSTODY_ARC=1, and capped per position.
  selfCustody: {
    arcEnabled: process.env.SELF_CUSTODY_ARC === "1",
    // The same flow on Sepolia, for testing it with worthless tokens. Only when this backend runs on Sepolia.
    sepoliaEnabled: process.env.SELF_CUSTODY_SEPOLIA === "1",
    // AquaPositionManager per chain (contracts/src/AquaPositionManager.sol). With one, a position
    // opens and closes in a single transaction; without, the wallet signs a ship / dock per strategy.
    arcManager: process.env.SELF_MANAGER_ARC ?? "",
    sepoliaManager: process.env.SELF_MANAGER_SEPOLIA ?? "",
    maxUsd: Number(process.env.SELF_CUSTODY_MAX_USD ?? 100),
    arcRpcUrl: process.env.ARC_RPC_URL || NETWORKS.arc.defaultRpcUrl,
  },
  // Dash out (dashOut.ts): selling a customer's leftover base token for USDC through Aqua. It is refused
  // when the best strategies pay more than this far below the market, and each swap carries a minimum
  // payout of its quote less the slippage allowance.
  dashOut: {
    maxDiscountPct: Number(process.env.DASH_OUT_MAX_DISCOUNT_PCT ?? 3),
    slippageBps: Number(process.env.DASH_OUT_SLIPPAGE_BPS ?? 50),
  },
  // Whether the yield page shows APY estimates (hidden on a real-money network).
  showApyEstimates: showApyEstimates(network.real, process.env.SHOW_APY_ESTIMATES),
  rpcUrl: primaryCfg?.rpcUrl ?? (process.env.RPC_URL || network.defaultRpcUrl),
  treasuryPrivateKey: process.env.TREASURY_PRIVATE_KEY ?? "",
  usdcAddress: primaryCfg?.usdcAddress ?? (process.env.USDC_ADDRESS || network.defaults.usdc),
  vaultAddress: primaryCfg?.vaultAddress ?? process.env.VAULT_ADDRESS ?? "",
  // Privy: email in,
  // real embedded wallet + a stable user id out, no phone/QR/bridge needed.
  privy: {
    appId: process.env.PRIVY_APP_ID ?? "",
    appSecret: process.env.PRIVY_APP_SECRET ?? "",
  },
  agent: {
    apiKey: process.env.ANTHROPIC_API_KEY ?? "",
    model: process.env.AGENT_MODEL ?? "claude-haiku-4-5-20251001",
  },
  withdrawFeeBps: Number(process.env.WITHDRAW_FEE_BPS ?? 200),
  databaseUrl: process.env.DATABASE_URL ?? "",
  redisUrl: process.env.REDIS_URL ?? "redis://localhost:6379",
  // Gmail SMTP with an App Password (myaccount.google.com/apppasswords).
  // Used for the QR email when set; otherwise Resend (needs a verified domain).
  gmail: {
    user: process.env.GMAIL_USER ?? "",
    appPassword: (process.env.GMAIL_APP_PASSWORD ?? "").replace(/\s+/g, ""),
  },
  resend: {
    apiKey: process.env.RESEND_API_KEY ?? "",
    from: process.env.RESEND_FROM ?? "",
  },
  // Brevo (HTTPS API, no domain needed: verify one sender address in Brevo).
  // BREVO_FROM like "Takarabako <you@gmail.com>".
  brevo: {
    apiKey: process.env.BREVO_API_KEY ?? "",
    from: process.env.BREVO_FROM ?? "",
  },
  // Curvegrid MultiBaas (multibaas.ts): contract calls, event indexing,
  // saved event queries and signed webhooks. Unset = everything that uses it
  // falls back (direct viem reads, no dashboard aggregates).
  multibaas: {
    url: (process.env.MULTIBAAS_URL ?? "").replace(/\/+$/, ""), // https://<id>.multibaas.com
    apiKey: process.env.MULTIBAAS_API_KEY ?? "", // admin key — backend only
    webhookSecret: process.env.MULTIBAAS_WEBHOOK_SECRET ?? "",
  },
  // Where MultiBaas can reach this backend (a tunnel in dev), for the webhook.
  publicBackendUrl: (process.env.PUBLIC_BACKEND_URL ?? "").replace(/\/+$/, ""),
  // tkCASH (contracts/src/TakarabakoCashReceipt.sol) and this kiosk's id in it.
  cashReceiptAddress: primaryCfg?.cashReceiptAddress ?? process.env.CASH_RECEIPT_ADDRESS ?? "",
  kioskId: process.env.KIOSK_ID ?? "mumbai-01",
  // Kiosks this backend used before (their tkCASH reserve is still redeemable).
  previousKioskIds: (process.env.KIOSK_PREVIOUS_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  // Treasury ops agent (opsAgent.ts): the model, and the token a human
  // sends to approve or reject its proposals.
  opsAgent: {
    model: process.env.OPS_AGENT_MODEL ?? "claude-opus-5",
    adminToken: process.env.OPS_ADMIN_TOKEN ?? "",
    // The agent's mandate (mandate.ts): "off" = every action waits for a human.
    autonomy: process.env.AGENT_AUTONOMY !== "off",
    // Daily signed treasury reports (report.ts): "off" = only on demand.
    dailyReports: process.env.AGENT_REPORTS !== "off",
  },
  // OpenAI-compatible chat API for both agents (llm.ts), e.g. OpenRouter.
  // Set = used instead of Anthropic; unset = the Anthropic key above.
  ai: {
    apiKey: process.env.AI_API_KEY ?? "",
    baseUrl: (process.env.AI_BASE_URL ?? "https://openrouter.ai/api/v1").replace(/\/+$/, ""),
    model: process.env.AI_MODEL ?? "openai/gpt-5-mini",
  },
  // One limit for every account: the most a customer can move a day in USD
  // (deposits, withdrawals, yield, sends — limits.ts). 0 = no limit.
  dailyLimitUsd: Number(process.env.DAILY_LIMIT_USD ?? 1000),
  // Verifiable kiosks (machine.ts): "required" rejects deposits that aren't
  // signed by a registered kiosk's device key; "optional"
  // credits them but marks them unverified.
  machineSignature: (process.env.MACHINE_SIGNATURE === "required" ? "required" : "optional") as "required" | "optional",
  // 1inch Aqua yield (aqua.ts). Addresses come from the official SDKs' per-chain
  // maps (networks.ts), or AQUA_ADDRESS / AQUA_ROUTER_ADDRESS. Aqua is not
  // deployed on Arc Testnet, so `deployed` is false there unless you set both.
  // On Sepolia the registry is shared and the router is the earlier deployment.
  // The base token is our mock mETH on Sepolia and bridged WETH on Arc Testnet.
  aqua: {
    deployed: Boolean(aquaDeployment),
    origin: aquaDeployment?.origin ?? null,
    address: aquaDeployment?.aqua ?? "",
    router: aquaDeployment?.router ?? "",
    methAddress: process.env.METH_ADDRESS || network.defaults.baseToken,
    // Demo market maker (aquaSimulator.ts): trades against open strategies
    // so they earn fees and move through their ranges on a quiet testnet.
    simEnabled: process.env.AQUA_SIM === "1",
    simIntervalMs: Number(process.env.AQUA_SIM_INTERVAL_MS ?? 600_000),
  },
  // USD per 1 MYR. Unset or 0 = use the live rate (see fx.ts).
  fx: {
    myrUsdRate: Number(process.env.MYR_USD_RATE ?? 0),
  },
} as const;
