import { Redis } from "ioredis";
import { config } from "./config.js";

/// One shared connection for commands and publishing. BullMQ and each SSE
/// subscriber get their own: a subscribed connection can't run commands.
// lazyConnect: nothing opens until first use (keeps imports side-effect free).
export const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: null, lazyConnect: true });

export function newRedisConnection() {
  return new Redis(config.redisUrl, { maxRetriesPerRequest: null });
}
