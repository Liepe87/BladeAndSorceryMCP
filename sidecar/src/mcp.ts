import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { TcpBridge } from "./tcp-bridge.js";
import { loadAllowlist } from "./guardrails.js";
import type { SpawnLimiter } from "./guardrails.js";

export interface Guards {
  limiter: SpawnLimiter;
  maxCreatures: number;
}

function text(value: unknown): { content: [{ type: "text"; text: string }] } {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

const round1 = (n: number): number => Math.round(n * 10) / 10;

export function createMcpServer(bridge: TcpBridge, guards: Guards): McpServer {
  const server = new McpServer({ name: "bas-mcp", version: "0.3.0" });

  server.tool(
    "ping",
    "Check whether the game bridge is connected and responding.",
    {},
    async () => {
      let gamePing: unknown = null;
      try {
        gamePing = await bridge.send("ping");
      } catch (e) {
        return text({ pong: false, gameConnected: bridge.gameConnected, error: (e as Error).message });
      }
      return text({ pong: true, gamePing, gameConnected: bridge.gameConnected });
    },
  );

  server.tool(
    "get_game_state",
    "Live Blade & Sorcery world state from the most recent snapshot (level, player, creatures, recent events).",
    {},
    async () => {
      return text(bridge.world.summary());
    },
  );

  server.tool(
    "list_creatures",
    "List creatures from the most recent snapshot, with position, health, state and faction.",
    {},
    async () => {
      return text([...bridge.world.creatures.values()]);
    },
  );

  server.tool(
    "spawn_creature",
    "Spawn a creature at a position (absolute, or relative to the player). Guarded by the catalog allowlist, a creature cap, and spawn rate limits.",
    {
      creatureId: z.string().describe("Catalog ID, e.g. Creature_HumanMale"),
      position: z.array(z.number()).length(3).optional().describe("Absolute world position [x, y, z]"),
      relativeToPlayer: z.array(z.number()).length(3).optional().describe("Offset from the player's current position [dx, dy, dz]"),
      factionId: z.number().optional().describe("0 = player faction, 3 = enemy, etc."),
      brainId: z.string().optional().describe("Brain ID, e.g. Brain_HumanEasy (defaults to HumanDummy)"),
    },
    async (args) => {
      const allowlist = loadAllowlist();
      if (!allowlist.creatures.includes(args.creatureId)) {
        return text({ ok: false, error: `creatureId '${args.creatureId}' is not in the allowlist (${allowlist.creatures.length} known creatures)` });
      }
      if (bridge.world.aliveCount() >= guards.maxCreatures) {
        return text({ ok: false, error: `creature cap reached (${guards.maxCreatures} alive)` });
      }
      const limitError = guards.limiter.trySpawn();
      if (limitError) {
        return text({ ok: false, error: limitError });
      }

      const params: Record<string, unknown> = { creatureId: args.creatureId };
      if (args.factionId !== undefined) params.factionId = args.factionId;
      if (args.brainId !== undefined) params.brainId = args.brainId;
      if (args.position !== undefined) {
        params.position = args.position.map(round1);
      } else if (args.relativeToPlayer !== undefined) {
        const p = bridge.world.player?.pos;
        if (!p) return text({ ok: false, error: "no player position known yet - wait for a snapshot" });
        params.position = [
          round1(p[0] + args.relativeToPlayer[0]),
          round1(p[1] + args.relativeToPlayer[1]),
          round1(p[2] + args.relativeToPlayer[2]),
        ];
      }

      try {
        const result = await bridge.send("spawn_creature", params);
        return text({ ok: true, result });
      } catch (e) {
        return text({ ok: false, error: (e as Error).message });
      }
    },
  );

  server.tool(
    "spawn_item",
    "Spawn an item at a position (absolute, or relative to the player). Guarded by the catalog allowlist and spawn rate limits.",
    {
      itemId: z.string().describe("Catalog ID, e.g. Item_Weapon_SwordLongCommon"),
      position: z.array(z.number()).length(3).optional().describe("Absolute world position [x, y, z]"),
      relativeToPlayer: z.array(z.number()).length(3).optional().describe("Offset from the player's current position [dx, dy, dz]"),
      owned: z.boolean().optional().describe("Set the player as owner (item goes to inventory-worthy state)"),
    },
    async (args) => {
      const allowlist = loadAllowlist();
      if (!allowlist.items.includes(args.itemId)) {
        return text({ ok: false, error: `itemId '${args.itemId}' is not in the allowlist (${allowlist.items.length} known items)` });
      }
      const limitError = guards.limiter.trySpawn();
      if (limitError) {
        return text({ ok: false, error: limitError });
      }

      const params: Record<string, unknown> = { itemId: args.itemId };
      if (args.owned !== undefined) params.owned = args.owned;
      if (args.position !== undefined) {
        params.position = args.position.map(round1);
      } else if (args.relativeToPlayer !== undefined) {
        const p = bridge.world.player?.pos;
        if (!p) return text({ ok: false, error: "no player position known yet - wait for a snapshot" });
        params.position = [
          round1(p[0] + args.relativeToPlayer[0]),
          round1(p[1] + args.relativeToPlayer[1]),
          round1(p[2] + args.relativeToPlayer[2]),
        ];
      }

      try {
        const result = await bridge.send("spawn_item", params);
        return text({ ok: true, result });
      } catch (e) {
        return text({ ok: false, error: (e as Error).message });
      }
    },
  );

  server.tool(
    "despawn_entity",
    "Despawn a creature or item by its instance ID (from list_creatures or events).",
    { instanceId: z.number().describe("Unity instance ID of the creature or item") },
    async (args) => {
      try {
        const result = await bridge.send("despawn_entity", { instanceId: args.instanceId });
        return text({ ok: true, result });
      } catch (e) {
        return text({ ok: false, error: (e as Error).message });
      }
    },
  );

  return server;
}
