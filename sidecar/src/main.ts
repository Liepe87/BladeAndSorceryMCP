import http from "node:http";
import { Readable } from "node:stream";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { TcpBridge } from "./tcp-bridge.js";
import { createMcpServer } from "./mcp.js";

// Logs go to stderr so stdout stays clean for the MCP stdio transport.
const log = (msg: string): void =>
  console.error(`[bas-mcp] ${new Date().toISOString()} ${msg}`);

const tcpPort = Number(process.env.BASMCP_PORT ?? 47777);
const httpPort = Number(process.env.BASMCP_HTTP_PORT ?? 47778);

const bridge = new TcpBridge(tcpPort, log);
bridge.start();

// stdio instance - for clients that spawn the sidecar themselves
const stdioServer = createMcpServer(bridge);
await stdioServer.connect(new StdioServerTransport());

// HTTP instances - for remote clients (opencode etc.) connecting to the
// already-running sidecar. Stateless mode: a fresh transport per request
// (the SDK's documented pattern). POSTs share one instance and are serialized
// so transports never overlap; GET SSE streams get their own instance so they
// can stay open without blocking anything (we send no server-initiated
// messages, but clients may still open a stream).
const httpMcp = createMcpServer(bridge);
const httpGetMcp = createMcpServer(bridge);

// Convert a Node IncomingMessage to a Web Request.
function toWebRequest(req: http.IncomingMessage): Request {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === "string") headers.set(key, value);
    else if (Array.isArray(value)) for (const v of value) headers.append(key, v);
  }
  const method = req.method ?? "GET";
  const hasBody = method !== "GET" && method !== "HEAD";
  const body = hasBody ? (Readable.toWeb(req) as ReadableStream<Uint8Array>) : undefined;
  return new Request(url, { method, headers, body, duplex: "half" });
}

// Write a Web Response to a Node ServerResponse; resolves when the response
// has been fully sent (or the connection closed).
function sendWebResponse(res: http.ServerResponse, webRes: Response): Promise<void> {
  return new Promise<void>((resolve) => {
    res.statusCode = webRes.status;
    webRes.headers.forEach((value, key) => res.setHeader(key, value));
    if (webRes.body) {
      const bodyStream = Readable.fromWeb(webRes.body as ReadableStream<Uint8Array>);
      bodyStream.pipe(res);
      res.on("finish", resolve);
      res.on("close", resolve);
    } else {
      res.end();
      resolve();
    }
  });
}

let postChain: Promise<void> = Promise.resolve();

const httpServer = http.createServer((req, res) => {
  if (req.method === "GET") {
    // Long-lived SSE stream on its own instance; never blocks POSTs.
    void (async () => {
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      try {
        await httpGetMcp.connect(transport);
        const webRes = await transport.handleRequest(toWebRequest(req), {});
        await sendWebResponse(res, webRes);
      } catch (err) {
        log(`HTTP GET error: ${(err as Error).message}`);
        if (!res.headersSent) {
          res.writeHead(500);
          res.end();
        }
      }
    })();
    return;
  }

  // Serialize POSTs so the per-request transports never overlap.
  postChain = postChain
    .then(async () => {
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      try {
        await httpMcp.connect(transport);
        const webRes = await transport.handleRequest(toWebRequest(req), {});
        await sendWebResponse(res, webRes);
        await transport.close();
      } catch (err) {
        log(`HTTP request error: ${(err as Error).stack ?? (err as Error).message}`);
        await transport.close().catch(() => undefined);
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "text/plain" });
          res.end("internal error");
        }
      }
    })
    .catch(() => undefined);
});

httpServer.on("error", (err) => log(`HTTP server error: ${err.message}`));
httpServer.listen(httpPort, "127.0.0.1", () =>
  log(`MCP HTTP endpoint on http://127.0.0.1:${httpPort}/mcp`),
);

log("MCP ready (stdio + HTTP)");
