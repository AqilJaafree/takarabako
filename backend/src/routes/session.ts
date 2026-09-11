import { Router } from "express";
import { sessionQrPayload } from "../worldId.js";

/// POST /session — PRD §7.3: returns World ID action params + QR payload
/// (IDKit `selfieCheckLegacy` preset) for the kiosk screen to render.
export const sessionRouter = Router();

sessionRouter.post("/session", (_req, res) => {
  res.json(sessionQrPayload());
});
