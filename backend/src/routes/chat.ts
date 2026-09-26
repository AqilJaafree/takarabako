import express, { Router } from "express";
import { z } from "zod";
import { requireSession } from "../sessions.js";
import { asyncHandler } from "../asyncHandler.js";
import { chatReady, checkFiles, createSession, deleteSession, getSession, listSessions, sendChatMessage } from "../customerChat.js";

/// Chat with Maneki (customerChat.ts), for logged-in customers (full
/// sessions only: it can prepare yield and withdraw confirmations). Mounted
/// before the app-wide JSON parser: uploads need a bigger body limit.
export const chatRouter = Router();
const json = express.json({ limit: "30mb" });

chatRouter.get("/chat/sessions", requireSession("full"), asyncHandler(async (_req, res) => {
  res.json({ sessions: await listSessions(res.locals.session.privyUserId), ready: chatReady });
}));

chatRouter.post("/chat/sessions", requireSession("full"), asyncHandler(async (_req, res) => {
  res.json({ session: await createSession(res.locals.session.privyUserId) });
}));

chatRouter.get("/chat/sessions/:id", requireSession("full"), asyncHandler(async (req, res) => {
  const session = await getSession(String(req.params.id), res.locals.session.privyUserId);
  if (!session) {
    res.status(404).json({ error: "chat not found" });
    return;
  }
  res.json({ session });
}));

chatRouter.delete("/chat/sessions/:id", requireSession("full"), asyncHandler(async (req, res) => {
  const ok = await deleteSession(String(req.params.id), res.locals.session.privyUserId);
  res.status(ok ? 200 : 404).json(ok ? { ok } : { error: "chat not found" });
}));

const MessageBody = z.object({
  text: z.string().max(4000).default(""),
  files: z.array(z.object({ name: z.string().max(200), type: z.string().max(100), dataUrl: z.string() })).max(3).default([]),
});

chatRouter.post("/chat/sessions/:id/messages", json, requireSession("full"), asyncHandler(async (req, res) => {
  if (!chatReady) {
    res.status(503).json({ error: "Chat isn't set up (AI_API_KEY)" });
    return;
  }
  const parsed = MessageBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "text or files required" });
    return;
  }
  const { text, files } = parsed.data;
  if (!text.trim() && files.length === 0) {
    res.status(400).json({ error: "Say something, or attach a file" });
    return;
  }
  const bad = checkFiles(files);
  if (bad) {
    res.status(400).json({ error: bad });
    return;
  }
  const result = await sendChatMessage(String(req.params.id), res.locals.session.privyUserId, text.trim(), files);
  if (!result) {
    res.status(404).json({ error: "chat not found" });
    return;
  }
  res.json(result);
}));
