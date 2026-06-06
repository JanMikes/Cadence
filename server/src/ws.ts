import type { ServerWebSocket } from "bun";
import type { ServerMessage } from "@cadence/shared";

export interface WsData {
  id: string;
}

/** Tracks connected web clients and fans out ServerMessages to them. */
export class WsHub {
  private readonly clients = new Set<ServerWebSocket<WsData>>();

  add(ws: ServerWebSocket<WsData>): void {
    this.clients.add(ws);
  }

  remove(ws: ServerWebSocket<WsData>): void {
    this.clients.delete(ws);
  }

  get size(): number {
    return this.clients.size;
  }

  send(ws: ServerWebSocket<WsData>, msg: ServerMessage): void {
    ws.send(JSON.stringify(msg));
  }

  broadcast(msg: ServerMessage): void {
    const data = JSON.stringify(msg);
    for (const ws of this.clients) ws.send(data);
  }
}
