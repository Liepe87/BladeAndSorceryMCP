import { loadAllowlist } from "./guardrails.js";
import type { SpawnLimiter } from "./guardrails.js";

export interface LevelRule {
  quiet?: boolean;
  spawnPoints?: number[][];
  llmGuidance?: string;
  burglar?: {
    enabled: boolean;
    minIntervalMs: number;
    maxEnemies: number;
    distanceMin?: number;
    distanceMax?: number;
    chance?: number;
  };
}

export interface LlmConfig {
  enabled: boolean;
  baseUrl: string;
  model: string;
  minIntervalMs: number;
  triggers: string[];
  timeoutMs: number;
  maxActions: number;
  levelRules?: Record<string, LevelRule>;
}

export const defaultLlmConfig: LlmConfig = {
  enabled: false,
  baseUrl: "https://openrouter.ai/api/v1",
  model: "deepseek/deepseek-chat",
  minIntervalMs: 60000,
  triggers: ["waveEnd", "killStreak", "lowHealth"],
  timeoutMs: 30000,
  maxActions: 3,
};

// Minimal structural interfaces so tests can inject fakes.
export interface LlmWorld {
  aliveCount(): number;
  recentEvents(count: number): unknown[];
  summary(): Record<string, unknown>;
}

export interface CommandChannel {
  send(op: string, params: Record<string, unknown>): Promise<unknown>;
}

interface Guards {
  limiter: SpawnLimiter;
  maxCreatures: number;
}

interface LlmAction {
  tool: string;
  args: Record<string, unknown>;
}

const ALLOWED_CREATURES = ["Chicken", "HumanFemale", "HumanMale", "Shopkeeper"];
const ALLOWED_BRAINS = ["HumanDummy", "HumanEasy", "HumanMedium", "HumanHard", "HumanVIP"];
const CURATED_ITEMS = [
  "PotionHealth", "SwordLongCommon", "SwordShortCommon", "SwordShortLarge",
  "AxeShortWar", "MaceShortCommon", "DaggerCommon", "ThrowablesDagger",
  "ShieldRound", "BowCommon", "Arrow",
];

function buildSystemPrompt(world: LlmWorld, config: LlmConfig): string {
  const state = world.summary();
  const level = ((state.level as { id?: string } | undefined)?.id) ?? "unknown";
  const rule = config.levelRules?.[level];

  const lines = [
    "You are the AI game master of a live Blade & Sorcery VR session.",
    "You watch combat events and react with small, immediate changes that make the fight more fun.",
    "Respond with ONLY a JSON object, no markdown, no commentary outside the JSON:",
    '{"comment": "one short in-character dungeon-master sentence", "actions": [{"tool": "...", "args": {...}}]}',
    "",
    "Allowed tools and arguments:",
    `- spawn_creature: {"creatureId": one of ${JSON.stringify(ALLOWED_CREATURES)}, "relativeToPlayer": [dx,dy,dz] OR "position": [x,y,z] OR "distanceFromPlayer": number (5-60, spawns far away on walkable ground, never in water), "brainId": one of ${JSON.stringify(ALLOWED_BRAINS)}, "factionId": 3 for enemy, "attackPlayer": true makes the enemy hunt the player immediately}`,
    `- spawn_item: {"itemId": one of ${JSON.stringify(CURATED_ITEMS)}, "relativeToPlayer": [dx,dy,dz], "owned": true|false}`,
    "- despawn_entity: {\"instanceId\": number}",
    "",
    "Rules:",
    "- At most 3 actions. At most 3 new enemies per reaction.",
    "- NEVER despawn the player. The player's instanceId is in the state below.",
    "- If the player is hurt, help. If the player is crushing everything, escalate gently.",
    "- Never spawn anything within 5 metres of the player. Prefer known spawn points or map edges so enemies approach naturally.",
    "- If nothing is worth doing, return an empty actions array.",
    "",
    `Current level: ${level}`,
  ];

  if (rule?.quiet) {
    lines.push("Level-specific instructions: SAFE ZONE. You MUST return an empty actions array.");
  }
  if (rule?.llmGuidance) {
    lines.push(`Level-specific instructions: ${rule.llmGuidance}`);
  }
  if (rule?.spawnPoints && rule.spawnPoints.length > 0) {
    lines.push(`Known spawn points (absolute coordinates, prefer these): ${JSON.stringify(rule.spawnPoints)}`);
  }

  lines.push("", `Current state: ${JSON.stringify(state)}`);
  return lines.join("\n");
}

// The model sometimes wraps JSON in code fences or adds prose. Extract the
// first {...} block, leniently.
function parseLlmJson(content: string): { comment: string; actions: LlmAction[] } {
  const fenced = content.replace(/```(?:json)?/g, "");
  const start = fenced.indexOf("{");
  const end = fenced.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("no JSON object in LLM response");
  }
  const parsed = JSON.parse(fenced.slice(start, end + 1));
  const actions = Array.isArray(parsed.actions) ? (parsed.actions as LlmAction[]) : [];
  return { comment: typeof parsed.comment === "string" ? parsed.comment : "", actions };
}

export class LlmReactor {
  private lastCall = 0;

  constructor(
    private channel: CommandChannel,
    private world: LlmWorld,
    private guards: Guards,
    private config: LlmConfig,
    private apiKey: string,
    private log: (msg: string) => void,
    private fetchFn: typeof fetch = fetch,
  ) {}

  async react(trigger: string): Promise<void> {
    if (!this.config.enabled) return;
    if (!this.config.triggers.includes(trigger)) return;

    // Never act in quiet zones (e.g. the shop).
    const summary = this.world.summary();
    const level = ((summary.level as { id?: string } | undefined)?.id) ?? "unknown";
    if (this.config.levelRules?.[level]?.quiet) return;

    const now = Date.now();
    if (now - this.lastCall < this.config.minIntervalMs) return;
    this.lastCall = now; // reserve the slot even if the call fails

    const userMessage = `Trigger: ${trigger}`;
    const body = {
      model: this.config.model,
      messages: [
        { role: "system", content: buildSystemPrompt(this.world, this.config) },
        { role: "user", content: userMessage },
      ],
    };

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
      const response = await this.fetchFn(`${this.config.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!response.ok) {
        throw new Error(`LLM API error ${response.status}: ${(await response.text()).slice(0, 200)}`);
      }
      const data = (await response.json()) as { choices?: { message?: { content?: string } }[] };
      const content = data.choices?.[0]?.message?.content ?? "";
      const parsed = parseLlmJson(content);

      if (parsed.comment) {
        this.log(`[gm-llm] ${trigger}: ${parsed.comment}`);
        // Show the dungeon master's narration in-game too.
        void this.channel
          .send("show_message", { text: parsed.comment, duration: 6 })
          .catch(() => undefined);
      }
      for (const action of parsed.actions.slice(0, this.config.maxActions)) {
        await this.execute(action);
      }
    } catch (e) {
      this.log(`[gm-llm] ${trigger} failed: ${(e as Error).message}`);
    }
  }

  private async execute(action: LlmAction): Promise<void> {
    try {
      switch (action.tool) {
        case "spawn_creature":
          await this.spawnCreature(action.args);
          break;
        case "spawn_item":
          await this.spawnItem(action.args);
          break;
        case "despawn_entity":
          await this.despawn(action.args);
          break;
        default:
          this.log(`[gm-llm] skipping unknown tool '${action.tool}'`);
      }
    } catch (e) {
      this.log(`[gm-llm] action failed: ${(e as Error).message}`);
    }
  }

  private async spawnCreature(args: Record<string, unknown>): Promise<void> {
    const creatureId = String(args.creatureId ?? "");
    if (!ALLOWED_CREATURES.includes(creatureId)) {
      this.log(`[gm-llm] rejected creature '${creatureId}' (not in curated list)`);
      return;
    }
    if (this.world.aliveCount() >= this.guards.maxCreatures) {
      this.log("[gm-llm] creature cap reached - skipped");
      return;
    }
    if (this.guards.limiter.trySpawn()) {
      this.log("[gm-llm] spawn rate limited - skipped");
      return;
    }
    const params: Record<string, unknown> = { creatureId };
    if (typeof args.relativeToPlayer === "object" && Array.isArray(args.relativeToPlayer)) {
      params.relativeToPlayer = args.relativeToPlayer;
    } else if (typeof args.position === "object" && Array.isArray(args.position)) {
      params.position = args.position;
    } else if (typeof args.distanceFromPlayer === "number") {
      const d = args.distanceFromPlayer;
      if (d >= 5 && d <= 60) {
        params.distanceFromPlayer = d;
      } else {
        this.log(`[gm-llm] rejected distanceFromPlayer ${d} (must be 5-60)`);
        return;
      }
    }
    if (args.attackPlayer === true) params.attackPlayer = true;
    const brainId = String(args.brainId ?? "");
    if (ALLOWED_BRAINS.includes(brainId)) params.brainId = brainId;
    if (args.factionId !== undefined) params.factionId = args.factionId;
    const result = await this.channel.send("spawn_creature", params);
    this.log(`[gm-llm] spawned ${creatureId}: ${JSON.stringify(result)}`);
  }

  private async spawnItem(args: Record<string, unknown>): Promise<void> {
    const itemId = String(args.itemId ?? "");
    if (!CURATED_ITEMS.includes(itemId)) {
      this.log(`[gm-llm] rejected item '${itemId}' (not in curated list)`);
      return;
    }
    if (this.guards.limiter.trySpawn()) {
      this.log("[gm-llm] spawn rate limited - skipped");
      return;
    }
    const params: Record<string, unknown> = { itemId };
    if (Array.isArray(args.relativeToPlayer)) params.relativeToPlayer = args.relativeToPlayer;
    if (args.owned !== undefined) params.owned = args.owned;
    const result = await this.channel.send("spawn_item", params);
    this.log(`[gm-llm] spawned ${itemId}: ${JSON.stringify(result)}`);
  }

  private async despawn(args: Record<string, unknown>): Promise<void> {
    const instanceId = Number(args.instanceId);
    if (!Number.isFinite(instanceId)) return;
    // Never despawn the player.
    const summary = this.world.summary();
    const creatures = Array.isArray(summary.creatures)
      ? (summary.creatures as { instanceId: number; isPlayer: boolean }[])
      : [];
    for (const c of creatures) {
      if (c.isPlayer && c.instanceId === instanceId) {
        this.log("[gm-llm] refused to despawn the player");
        return;
      }
    }
    const result = await this.channel.send("despawn_entity", { instanceId });
    this.log(`[gm-llm] despawned ${instanceId}: ${JSON.stringify(result)}`);
  }
}
