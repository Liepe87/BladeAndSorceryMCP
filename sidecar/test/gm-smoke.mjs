// gm-smoke.mjs — tests the always-on game master against a fake game.
// Spawns the sidecar with the test GM config, feeds snapshots/events that
// trigger rules, and asserts the GM issues the expected commands.
import { spawn } from "node:child_process";
import net from "node:net";

const TCP_PORT = 47785;
const HTTP_PORT = 47786;
let failures = 0;
function check(label, cond) {
  console.log(`${cond ? "PASS" : "FAIL"} ${label}`);
  if (!cond) failures++;
}

const child = spawn(process.execPath, ["dist/main.js"], {
  env: {
    ...process.env,
    BASMCP_PORT: String(TCP_PORT),
    BASMCP_HTTP_PORT: String(HTTP_PORT),
    BASMCP_GM_CONFIG: "test/gm-test-config.json",
  },
  stdio: ["ignore", "ignore", "inherit"],
});
await new Promise((r) => setTimeout(r, 1200));

const socket = net.connect(TCP_PORT, "127.0.0.1");
await new Promise((r) => socket.on("connect", r));
const send = (m) => socket.write(JSON.stringify(m) + "\n");

const commands = [];
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
      commands.push({ op: msg.op, params: msg.params ?? {} });
      if (msg.op === "spawn_item") send({ type: "reply", id: msg.id, ok: true, result: { accepted: true, itemId: msg.params.itemId } });
      else if (msg.op === "despawn_entity") send({ type: "reply", id: msg.id, ok: true, result: { despawned: true, kind: "creature" } });
      else if (msg.op === "spawn_creature") send({ type: "reply", id: msg.id, ok: true, result: { accepted: true, creatureId: msg.params.creatureId } });
      else if (msg.op === "show_message") send({ type: "reply", id: msg.id, ok: true, result: { shown: true } });
      else send({ type: "reply", id: msg.id, ok: true, result: {} });
    }
  }
});

send({ type: "hello", modVersion: "0.4.1", gameVersion: "1.3.1" });

// Snapshot 1: player at 50hp (below the 90 threshold) + one void corpse
send({
  type: "snapshot", seq: 1, gameTime: 1,
  level: { id: "Arena", mode: "Sandbox" },
  player: { present: true, pos: [0, 0, 0], health: 50 },
  creatures: [
    { instanceId: 1, type: "HumanMale", state: "Alive", health: 50, faction: 2, isPlayer: true, pos: [0, 0, 0], dist: 0 },
    { instanceId: 999, type: "HumanMale", state: "Dead", health: 0, faction: 3, isPlayer: false, pos: [5, -100, 5], dist: 141 },
  ],
});

await new Promise((r) => setTimeout(r, 2000));

const earlyActions = commands.filter((c) => c.op === "spawn_item" || c.op === "show_message");
check("low health triggers nothing (no potions, no messages)", earlyActions.length === 0);
const cleanups = commands.filter((c) => c.op === "despawn_entity" && c.params.instanceId === 999);
check("void corpse cleaned up", cleanups.length >= 1);

// Kill 1 at [1,0,1]: loot roll (chance 1.0, table = Poo) drops Poo
send({ type: "event", name: "creature_kill", data: { instanceId: 500, type: "HumanMale", pos: [1, 0, 1] } });
await new Promise((r) => setTimeout(r, 800));
const pooDrop1 = commands.filter(
  (c) => c.op === "spawn_item" && c.params.itemId === "Poo" && Array.isArray(c.params.position),
);
check(
  "kill dropped loot at the corpse position",
  pooDrop1.length >= 1 && Math.abs(pooDrop1[0].params.position[1] - 0.3) < 0.001,
);

// Kill 2 at [2,0,2]: another loot drop
send({ type: "event", name: "creature_kill", data: { instanceId: 501, type: "HumanMale", pos: [2, 0, 2] } });
await new Promise((r) => setTimeout(r, 800));
const pooDrops = commands.filter((c) => c.op === "spawn_item" && c.params.itemId === "Poo");
check("second kill also dropped loot", pooDrops.length >= 2);
const pooMessages = commands.filter((c) => c.op === "show_message" && /smell/i.test(c.params.text ?? ""));
check("poo drop announced", pooMessages.length >= 1);

// Shop is a safe zone: low health must NOT trigger anything
const commandsBeforeShop = commands.length;
send({
  type: "snapshot", seq: 2, gameTime: 2,
  level: { id: "Shop", mode: "Sandbox" },
  player: { present: true, pos: [0, 0, 0], health: 40 },
  creatures: [{ instanceId: 1, type: "HumanMale", state: "Alive", health: 40, faction: 2, isPlayer: true, pos: [0, 0, 0], dist: 0 }],
});
await new Promise((r) => setTimeout(r, 1500));
const shopActions = commands.slice(commandsBeforeShop).filter((c) => c.op === "spawn_item" || c.op === "show_message");
check("shop safe zone: nothing spawned or announced", shopActions.length === 0);

// Home: burglars sneak in from far away and hunt the player
const commandsBeforeHome = commands.length;
send({
  type: "snapshot", seq: 3, gameTime: 3,
  level: { id: "Home", mode: "Sandbox" },
  player: { present: true, pos: [37.7, 1.87, -46.4], health: 100 },
  creatures: [{ instanceId: 1, type: "HumanMale", state: "Alive", health: 100, faction: 2, isPlayer: true, pos: [37.7, 1.87, -46.4], dist: 0 }],
});
await new Promise((r) => setTimeout(r, 2500));
const burglarSpawns = commands.slice(commandsBeforeHome).filter((c) => c.op === "spawn_creature");
check(
  "home burglars spawn far away and hunt the player",
  burglarSpawns.length >= 1 &&
    burglarSpawns.every(
      (c) => typeof c.params.distanceFromPlayer === "number" && c.params.attackPlayer === true,
    ),
);
const burglarMessages = commands.slice(commandsBeforeHome).filter((c) => c.op === "show_message" && /door/i.test(c.params.text ?? ""));
check("burglar event displayed an in-game message", burglarMessages.length >= 1);

socket.end();
child.kill();
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
