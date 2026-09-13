import express from "express";
import { config } from "./config.js";
import { verifyRouter } from "./routes/verify.js";
import { depositRouter } from "./routes/deposit.js";
import { agentRouter } from "./routes/agentRoutes.js";
import { withdrawRouter } from "./routes/withdraw.js";
import { positionRouter } from "./routes/position.js";

const app = express();
app.use(express.json());

// Dev-only convenience: the kiosk page (device-agent) fetches this API
// directly from the browser. Lock this down (or put both behind one origin)
// before this ever leaves a hackathon table.
app.use((_req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  res.header("Access-Control-Allow-Methods", "GET,POST");
  next();
});

app.get("/health", (_req, res) => res.json({ ok: true }));

app.use(verifyRouter);
app.use(depositRouter);
app.use(agentRouter);
app.use(withdrawRouter);
app.use(positionRouter);

// Catches anything asyncHandler forwards (chain calls, Privy, the agent) —
// without this, an unhandled rejection in an async route takes the whole
// process down instead of just failing that one request.
app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err);
  const message = err instanceof Error ? err.message : "internal error";
  res.status(500).json({ error: message });
});

app.listen(config.port, () => {
  console.log(`takarabako backend listening on :${config.port}`);
});
