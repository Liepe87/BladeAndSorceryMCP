import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { TcpBridge } from "./tcp-bridge.js";

export function createMcpServer(bridge: TcpBridge): McpServer {
  const server = new McpServer({ name: "bas-mcp", version: "0.2.0" });

  server.tool(
    "ping",
    "Check whether the game bridge is connected and responding.",
    {},
    async () => {
      let gamePing: unknown = null;
      try {
        gamePing = await bridge.send("ping");
      } catch (e) {
        const err = e as Error;
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { pong: false, gameConnected: bridge.gameConnected, error: err.message },
                null,
                2,
              ),
            },
          ],
        };
      }
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ pong: true, gamePing, gameConnected: bridge.gameConnected }, null, 2),
          },
        ],
      };
    },
  );

  server.tool(
    "get_game_state",
    "Live Blade & Sorcery world state from the most recent snapshot (level, player, creatures, recent events).",
    {},
    async () => {
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(bridge.world.summary(), null, 2) },
        ],
      };
    },
  );

  server.tool(
    "list_creatures",
    "List creatures from the most recent snapshot, with position, health, state and faction.",
    {},
    async () => {
      const list = [...bridge.world.creatures.values()];
      return {
        content: [{ type: "text" as const, text: JSON.stringify(list, null, 2) }],
      };
    },
  );

  return server;
}
