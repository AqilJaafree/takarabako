/// Public RPC endpoints sit behind load balancers, so a call made right after
/// a transaction was confirmed can land on a node that is a block behind and
/// has not seen it: gas estimates and eth_calls then revert, or the block is
/// "not found". The same call a few seconds later succeeds. Real failures
/// (no funds, a bad nonce, a permanent revert) must not be hidden by this:
/// only errors that look like lag are retried, and a persistent one is still
/// thrown after the last try.

const message = (err: unknown) => (err instanceof Error ? `${err.message} ${(err as { details?: string }).details ?? ""}` : String(err));

export const looksLikeRpcLag = (err: unknown): boolean => /revert|block not found|header not found|unknown block|missing trie node/i.test(message(err));

export async function retryOnLag<T>(
  fn: () => Promise<T>,
  { tries = 5, delayMs = 3_000, isLag = looksLikeRpcLag }: { tries?: number; delayMs?: number; isLag?: (err: unknown) => boolean } = {},
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= tries || !isLag(err)) throw err;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}
