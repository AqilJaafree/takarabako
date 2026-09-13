export const config = {
  port: Number(process.env.PORT ?? 4000),
  rpcUrl: process.env.RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com",
  treasuryPrivateKey: process.env.TREASURY_PRIVATE_KEY ?? "",
  usdcAddress: process.env.USDC_ADDRESS ?? "",
  vaultAddress: process.env.VAULT_ADDRESS ?? "",
  // PRD §7.8 (revised) — Privy replaces World ID Selfie Check: email in,
  // real embedded wallet + a stable user id out, no phone/QR/bridge needed.
  privy: {
    appId: process.env.PRIVY_APP_ID ?? "",
    appSecret: process.env.PRIVY_APP_SECRET ?? "",
  },
  ens: {
    parentName: process.env.ENS_PARENT_NAME ?? "wantest.eth",
  },
  agent: {
    apiKey: process.env.ANTHROPIC_API_KEY ?? "",
    model: process.env.AGENT_MODEL ?? "claude-haiku-4-5-20251001",
  },
  withdrawFeeBps: Number(process.env.WITHDRAW_FEE_BPS ?? 200),
} as const;
