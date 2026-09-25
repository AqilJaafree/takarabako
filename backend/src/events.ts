import { redis, newRedisConnection } from "./redis.js";

/// Per-user live events. Published on Redis so every backend instance's SSE
/// clients (the kiosk screen, the customer's phone, the Pi bridge) hear them.
export type UserEvent =
  | { type: "deposit.pending"; depositId: string; amount: number; currency: string; estUsd: number | null }
  | { type: "deposit.retrying"; depositId: string; attempt: number; maxAttempts: number; error: string }
  | {
      type: "deposit.confirmed";
      depositId: string;
      amount: number;
      currency: string;
      usdAmount: number;
      fxRate: number;
      txHash: string;
      balance: number;
    }
  | { type: "deposit.failed"; depositId: string; amount: number; currency: string; error: string };

const channel = (privyUserId: string) => `user:${privyUserId}`;

export async function publishUserEvent(privyUserId: string, event: UserEvent) {
  await redis.publish(channel(privyUserId), JSON.stringify({ ...event, ts: Date.now() }));
}

/// Calls `onEvent` with each event's JSON on the user's channel until the
/// returned function is called.
export async function subscribeUserEvents(privyUserId: string, onEvent: (json: string) => void) {
  const sub = newRedisConnection();
  await sub.subscribe(channel(privyUserId));
  sub.on("message", (_channel, message) => onEvent(message));
  return async () => {
    await sub.unsubscribe().catch(() => {});
    sub.disconnect();
  };
}
