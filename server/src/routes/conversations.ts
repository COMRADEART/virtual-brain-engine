import { Router } from "express";
import { getConversation, listConversations, listMessages } from "../db/repositories/conversations.js";

export const conversationsRouter = Router();

conversationsRouter.get("/conversations", (_req, res) => {
  res.json({ conversations: listConversations() });
});

conversationsRouter.get("/conversations/:id", (req, res) => {
  const conversation = getConversation(req.params.id);
  if (!conversation) {
    res.status(404).json({ error: "Conversation not found" });
    return;
  }
  const limit = Math.min(100, Math.max(1, Number(req.query.limit ?? 100)));
  const offset = Math.max(0, Number(req.query.offset ?? 0));
  const messages = listMessages(req.params.id, limit, offset);
  res.json({ conversationId: req.params.id, messages });
});
