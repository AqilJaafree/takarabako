export const config = {
  port: Number(process.env.PORT ?? 4000),
  rpcUrl: process.env.RPC_URL ?? "https://sepolia.base.org",
  treasuryPrivateKey: process.env.TREASURY_PRIVATE_KEY ?? "",
  usdcAddress: process.env.USDC_ADDRESS ?? "",
  vaultAddress: process.env.VAULT_ADDRESS ?? "",
  world: {
    appId: process.env.WORLD_APP_ID ?? "",
    actionId: process.env.WORLD_ACTION_ID ?? "takarabako-verify",
    // "staging" points IDKit at the World ID Sandbox simulator (PRD §7.8)
    // so the demo doesn't depend on a judge holding a pre-verified account.
    environment: process.env.WORLD_ENVIRONMENT ?? "staging",
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
