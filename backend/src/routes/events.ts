import { Router } from "express";
import { requireSession } from "../sessions.js";
import { subscribeUserEvents } from "../events.js";
import { asyncHandler } from "../asyncHandler.js";

/// GET /events/stream — Server-Sent Events of the session user's live events
/// (deposit pending/retrying/confirmed/failed). Any live session may listen:
/// the kiosk screen, the customer's phone, and the Pi bridge. A 20s heartbeat
/// keeps proxies from closing an idle stream.
export const eventsRouter = Router();

eventsRouter.get("/events/stream", requireSession("deposit"), asyncHandler(async (req, res) => {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no", // nginx on the DigitalOcean box must not buffer the stream
  });
  res.write(": connected\n\n");

  const unsubscribe = await subscribeUserEvents(res.locals.session.privyUserId, (json) => {
    res.write(`data: ${json}\n\n`);
  });
  const heartbeat = setInterval(() => res.write(": ping\n\n"), 20_000);

  req.on("close", () => {
    clearInterval(heartbeat);
    void unsubscribe();
  });
}));
