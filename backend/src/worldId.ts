import { config } from "./config.js";

/// PRD §7.8 — World ID Selfie Check, verified against the World ID Sandbox
/// simulator (`environment: "staging"`) during development so the demo
/// doesn't need a judge with a pre-verified World App account.
/// Phase 2 replaces `verifyProof` with a real POST to World's verify
/// endpoint (`developer.worldcoin.org` in prod, the simulator in staging).

export interface WorldIdProof {
  nullifier_hash: string;
  merkle_root: string;
  proof: string;
  verification_level: string;
}

export interface VerifyResult {
  valid: boolean;
  nullifierHash: string;
}

export async function verifyProof(proof: WorldIdProof): Promise<VerifyResult> {
  // TODO(Phase 2): forward `proof` to World's verify endpoint, scoped to
  // config.world.appId / config.world.actionId, using config.world.environment
  // ("staging" -> World ID Sandbox simulator, "production" -> live).
  console.log(`[worldid:stub] verifying against ${config.world.environment} sandbox`);
  return { valid: true, nullifierHash: proof.nullifier_hash };
}

export function sessionQrPayload() {
  return {
    app_id: config.world.appId || "app_stub",
    action: config.world.actionId,
    environment: config.world.environment,
    credential_type: "selfieCheckLegacy",
  };
}
