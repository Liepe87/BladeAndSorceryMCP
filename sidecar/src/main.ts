import http from "node:http";
import {
  appendFileSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { TcpBridge } from "./tcp-bridge.js";
import { createMcpServer } from "./mcp.js";
import { loadAllowlist, SpawnLimiter } from "./guardrails.js";
import { GameMaster, defaultGmConfig } from "./gm.js";
import type { GmConfig } from "./gm.js";
import { LlmReactor, defaultLlmConfig } from "./gm-llm.js";

const sidecarDir = dirname(fileURLToPath(import.meta.url));
const sidecarLogPath = join(sidecarDir, "..", "sidecar.log");

// Rotate the session log if it has grown past 5MB.
try {
  if (statSync(sidecarLogPath).size > 5 * 1024 * 1024) {
    try {
      unlinkSync(sidecarLogPath + ".old");
    } catch {
      // no previous .old
    }
    renameSync(sidecarLogPath, sidecarLogPath + ".old");
  }
} catch {
  // no log file yet
}

// Logs go to stderr (keeps stdout clean for the MCP stdio transport) and are
// also appended to sidecar.log so sessions can be reviewed afterwards.
const log = (msg: string): void => {
  const line = `[bas-mcp] ${new Date().toISOString()} ${msg}`;
  console.error(line);
  try {
    appendFileSync(sidecarLogPath, line + "\n", "utf8");
  } catch {
    // log file unavailable - console only
  }
};

// Load sidecar/.env if present (never overrides existing environment vars).
function loadDotEnv(): void {
  const envPath = join(dirname(fileURLToPath(import.meta.url)), "..", ".env");
  try {
    const content = readFileSync(envPath, "utf8");
    let loaded = 0;
    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (line === "" || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq === -1) continue;
      const key = line.slice(0, eq).trim();
      const value = line.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
      if (key && process.env[key] === undefined) {
        process.env[key] = value;
        loaded++;
      }
    }
    if (loaded > 0) log(`loaded ${loaded} variable(s) from .env`);
  } catch {
    // no .env file - fine
  }
}
loadDotEnv();

const tcpPort = Number(process.env.BASMCP_PORT ?? 47777);
const httpPort = Number(process.env.BASMCP_HTTP_PORT ?? 47778);

const bridge = new TcpBridge(tcpPort, log);
bridge.start();

const guards = {
  limiter: new SpawnLimiter(
    Number(process.env.BASMCP_SPAWN_PER_MIN ?? 30),
    Number(process.env.BASMCP_SPAWN_INTERVAL_MS ?? 500),
  ),
  maxCreatures: Number(process.env.BASMCP_MAX_CREATURES ?? 20),
};

// Game master: observes the bridge stream and reacts on its own.
function loadGmConfig(): GmConfig {
  const defaultPath = join(dirname(fileURLToPath(import.meta.url)), "..", "gm.json");
  const path = process.env.BASMCP_GM_CONFIG ?? defaultPath;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
    const llm = { ...defaultLlmConfig, ...((raw as { llm?: object }).llm ?? {}) };
    // .env / environment overrides the file config
    if (process.env.BASMCP_LLM_MODEL) llm.model = process.env.BASMCP_LLM_MODEL;
    return { ...defaultGmConfig, ...(raw as Partial<GmConfig>), llm };
  } catch (e) {
    log(`GM config load failed (${(e as Error).message}) - using defaults`);
    return defaultGmConfig;
  }
}

if (process.env.BASMCP_GM !== "0") {
  const gmConfig = loadGmConfig();
  if (gmConfig.enabled) {
    let llmReactor: LlmReactor | undefined;
    if (gmConfig.llm?.enabled) {
      const apiKey = process.env.OPENROUTER_API_KEY;
      if (!apiKey) {
        log("GM LLM enabled in config but OPENROUTER_API_KEY is not set - LLM disabled");
      } else {
        llmReactor = new LlmReactor(bridge, bridge.world, guards, gmConfig.llm, apiKey, log);
        log(`game master LLM enabled (${gmConfig.llm.model})`);
      }
    }
    new GameMaster(bridge, gmConfig, log, llmReactor);
    log("game master enabled");
  }
}

// stdio instance - for clients that spawn the sidecar themselves
const stdioServer = createMcpServer(bridge, guards);
await stdioServer.connect(new StdioServerTransport());

// HTTP instances - for remote clients (opencode etc.) connecting to the
// already-running sidecar. Stateless mode: a fresh transport per request
// (the SDK's documented pattern). POSTs share one instance and are serialized
// so transports never overlap; GET SSE streams get their own instance so they
// can stay open without blocking anything (we send no server-initiated
// messages, but clients may still open a stream).
const httpMcp = createMcpServer(bridge, guards);
const httpGetMcp = createMcpServer(bridge, guards);

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
