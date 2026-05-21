import { WebSocketServer, WebSocket } from "ws";
import type { Server } from "node:http";
import type { BrainBusMessage } from "../../../shared/pipeline.js";
import { getMemoryCount } from "../db/repositories/memory.js";

let wss: WebSocketServer | null = null;
const clients = new Set<WebSocket>();

export function attachBrainBus(server: Server): void {
  wss = new WebSocketServer({ server, path: "/ws/brain" });
  wss.on("connection", (socket) => {
    clients.add(socket);
    socket.on("close", () => clients.delete(socket));
    socket.on("error", () => clients.delete(socket));
    try {
      socket.send(JSON.stringify({ type: "connector", connectorId: "ws", state: "ok" }));
      socket.send(JSON.stringify({ type: "memory-count", count: getMemoryCount() }));
    } catch {
      // ignore
    }
  });
}

export function broadcast(message: BrainBusMessage): void {
  if (!wss) {
    return;
  }
  const data = JSON.stringify(message);
  for (const socket of clients) {
    if (socket.readyState === WebSocket.OPEN) {
      try {
        socket.send(data);
      } catch {
        // ignore individual client failures
      }
    }
  }
}

export function clientCount(): number {
  return clients.size;
}
