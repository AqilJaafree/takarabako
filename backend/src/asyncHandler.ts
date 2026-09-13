import type { Request, Response, NextFunction, RequestHandler } from "express";

/// Express 4 doesn't forward a rejected promise from an async handler to
/// its error middleware — it becomes an unhandled rejection and, by
/// default, kills the whole Node process. Every route in this backend is
/// async (chain calls, Privy verification, the agent), so wrap each one
/// with this instead of hand-rolling try/catch per route.
export function asyncHandler(fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}
