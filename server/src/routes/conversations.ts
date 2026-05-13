import { Router } from "express";
import { listConversations, listMessages } from "../db/repositories/conversations.js";

export const conversationsRouter = Router();

conversationsRouter.get("/conversations", (_req, res) => {
  res.json({ conversations: listConversations() });
});

conversationsRouter.get("/conversations/:id", (req, res) => {
  const messages = listMessages(req.params.id);
  res.json({ conversationId: req.params.id, messages });
});
