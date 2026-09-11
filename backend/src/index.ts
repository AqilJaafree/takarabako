import express from "express";
import { config } from "./config.js";
import { sessionRouter } from "./routes/session.js";
import { depositRouter } from "./routes/deposit.js";
import { verifyRouter } from "./routes/verify.js";
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

app.use(sessionRouter);
app.use(depositRouter);
app.use(verifyRouter);
app.use(agentRouter);
app.use(withdrawRouter);
app.use(positionRouter);

app.listen(config.port, () => {
  console.log(`takarabako backend listening on :${config.port}`);
});
