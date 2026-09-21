// http-smoke.mjs — full M1 test over the HTTP endpoint, as opencode would use it.
// Spawns the sidecar standalone, drives a fake game over the TCP bridge, and
// calls the MCP tools through a remote (HTTP) client.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { spawn } from "node:child_process";
import net from "node:net";

const TCP_PORT = 47779;
const HTTP_PORT = 47780;
let failures = 0;
function check(label, cond) {
  console.log(`${cond ? "PASS" : "FAIL"} ${label}`);
  if (!cond) failures++;
}

const child = spawn(process.execPath, ["dist/main.js"], {
  env: { ...process.env, BASMCP_PORT: String(TCP_PORT), BASMCP_HTTP_PORT: String(HTTP_PORT) },
  stdio: ["ignore", "ignore", "inherit"],
});
await new Promise((r) => setTimeout(r, 1200));

const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${HTTP_PORT}/mcp`));
const client = new Client({ name: "http-smoke", version: "0.0.1" });
await client.connect(transport);
console.log("HTTP MCP client connected");

// --- fake game over TCP ---
const socket = net.connect(TCP_PORT, "127.0.0.1");
await new Promise((r) => socket.on("connect", r));
const send = (m) => socket.write(JSON.stringify(m) + "\n");

send({ type: "hello", modVersion: "0.2.0", gameVersion: "1.3.1" });
send({
  type: "snapshot", seq: 1, gameTime: 10.5,
  level: { id: "Arena", mode: "Sandbox" },
  player: { present: true, pos: [1.5, 2, -3.25], health: 100 },
  creatures: [
    { instanceId: 101, type: "HumanMale", state: "Alive", health: 100, faction: 0, isPlayer: false, pos: [3, 0, 0], dist: 3.5 },
    { instanceId: 102, type: "HumanFemale", state: "Alive", health: 80, faction: 3, isPlayer: false, pos: [-2, 0, 1], dist: 4.0 },
  ],
});
send({ type: "event", name: "creature_spawn", data: { instanceId: 103, type: "HumanMale", faction: 0, pos: [0, 0, 5] } });

let buffer = "";
socket.on("data", (c) => {
  buffer += c.toString();
  let i;
  while ((i = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, i).trim();
    buffer = buffer.slice(i + 1);
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (typeof msg.op === "string") {
      if (msg.op === "ping") send({ type: "reply", id: msg.id, ok: true, result: { pong: true, gameTime: 123.4 } });
      else if (msg.op === "get_state") send({ type: "reply", id: msg.id, ok: true, result: { level: { id: "Arena" }, player: { present: true, health: 99 }, creatures: [] } });
      else send({ type: "reply", id: msg.id, ok: false, error: "unknown op" });
    }
  }
});

await new Promise((r) => setTimeout(r, 1500));

// --- MCP tool calls over HTTP ---
const tools = await client.listTools();
console.log("TOOLS:", tools.tools.map((t) => t.name).join(", "));
check("three tools exposed", tools.tools.length === 3);

const state = await client.callTool({ name: "get_game_state", arguments: {} });
const stateObj = JSON.parse(state.content[0].text);
check("world sees game connected", stateObj.connected === true);
check("world sees level Arena", stateObj.level?.id === "Arena");
check("world has 3 creatures (2 snapshot + 1 event)", stateObj.creatureCount === 3);
check("player health 100", stateObj.player?.health === 100);

const creatures = await client.callTool({ name: "list_creatures", arguments: {} });
const creatureList = JSON.parse(creatures.content[0].text);
check("list_creatures has 3 entries", creatureList.length === 3);

const ping = await client.callTool({ name: "ping", arguments: {} });
const pingObj = JSON.parse(ping.content[0].text);
check("ping reaches fake game and gets pong", pingObj.pong === true && pingObj.gamePing?.pong === true);

socket.end();
await client.close();
child.kill();
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
