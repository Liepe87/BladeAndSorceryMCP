import net from "node:net";
import { WorldModel } from "./world.js";

interface PendingOp {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

export class TcpBridge {
  world = new WorldModel();
  private server: net.Server;
  private sockets = new Set<net.Socket>();
  private pending = new Map<number, PendingOp>();
  private nextId = 1;
  private verbose = process.env.BASMCP_VERBOSE === "1";

  constructor(
    private port: number,
    private log: (msg: string) => void,
  ) {
    this.server = net.createServer((socket) => this.onConnection(socket));
  }

  start(): void {
    this.server.on("error", (err) => this.log(`TCP server error: ${err.message}`));
    this.server.listen(this.port, "127.0.0.1", () => this.log(`TCP bridge listening on 127.0.0.1:${this.port}`));
  }

  get gameConnected(): boolean {
    return this.sockets.size > 0;
  }

  private onConnection(socket: net.Socket): void {
    this.sockets.add(socket);
    this.log("game connected");
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let idx: number;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (line.length > 0) this.handleLine(line);
      }
    });
    socket.on("close", () => {
      this.sockets.delete(socket);
      this.world.connected = false;
      this.log("game disconnected");
    });
    socket.on("error", () => {
      /* handled via close */
    });
  }

  private handleLine(line: string): void {
    if (this.verbose) this.log(`<< ${line.length > 200 ? line.slice(0, 200) + "..." : line}`);
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }

    if (msg.type === "reply" && typeof msg.id === "number") {
      const p = this.pending.get(msg.id);
      if (p) {
        clearTimeout(p.timer);
        this.pending.delete(msg.id);
        if (msg.ok === true) p.resolve(msg.result);
        else p.reject(new Error((msg.error as string) ?? "game error"));
      }
      return;
    }

    this.world.apply(msg);
  }

  send(op: string, params: Record<string, unknown> = {}, timeoutMs = 8000): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const socket = [...this.sockets][0];
      if (!socket) {
        reject(new Error("no game connection"));
        return;
      }
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`game command '${op}' timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      const out = JSON.stringify({ id, op, params }) + "\n";
      if (this.verbose) this.log(`>> ${out.trim()}`);
      socket.write(out);
    });
  }
}
