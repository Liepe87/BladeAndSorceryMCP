import type { TcpBridge } from "./tcp-bridge.js";
import type { LlmReactor } from "./gm-llm.js";
import type { LlmConfig, LevelRule } from "./gm-llm.js";

export interface GmConfig {
  enabled: boolean;
  cleanupVoidCorpses: boolean;
  waveSettleMs: number;
  lowHealthPotion: { enabled: boolean; threshold: number; cooldownMs: number };
  waveEndReward: {
    enabled: boolean;
    minSessionKills: number;
    cooldownMs: number;
    items: string[];
  };
  killStreakLog: { enabled: boolean; kills: number; windowMs: number };
  levelRules?: Record<string, LevelRule>;
  llm?: LlmConfig;
}

export const defaultGmConfig: GmConfig = {
  enabled: true,
  cleanupVoidCorpses: true,
  waveSettleMs: 10000,
  lowHealthPotion: { enabled: true, threshold: 60, cooldownMs: 120000 },
  waveEndReward: {
    enabled: true,
    minSessionKills: 5,
    cooldownMs: 300000,
    items: ["PotionHealth", "SwordLongCommon", "AxeShortWar", "ThrowablesDagger"],
  },
  killStreakLog: { enabled: true, kills: 3, windowMs: 10000 },
};

interface SnapshotCreature {
  state: string;
  isPlayer: boolean;
  instanceId: number;
  pos: number[];
}

/**
 * Always-on game master. Subscribes to the bridge's message stream (events +
 * snapshots) and reacts through the same command channel the MCP tools use.
 * Tier 1: deterministic rules. Tier 2 (LLM reactions) slots into the same
 * hooks later.
 */
export class GameMaster {
  private cooldowns = new Map<string, number>();
  private killTimes: number[] = [];
  private sessionKills = 0;
  private enemiesAlive = 0;
  private lastEnemiesAlive = 0;
  private playerHealth = -1;
  private zeroSince = 0;
  private waveSettled = false;
  private voidCorpses = new Map<number, number>(); // instanceId -> y
  private lastCleanupAt = 0;
  private currentLevel: string | null = null;
  private killsAtLastWaveEnd = 0;
  private lastBurglarAt = 0;

  constructor(
    private bridge: TcpBridge,
    private config: GmConfig,
    private log: (msg: string) => void,
    private llm?: LlmReactor,
  ) {
    bridge.onMessage((msg) => this.handleMessage(msg));
    setInterval(() => this.tick(), 1000);
    this.log("[gm] game master active");
  }

  private handleMessage(msg: Record<string, unknown>): void {
    if (!this.config.enabled) return;
    if (msg.type === "snapshot") this.onSnapshot(msg);
    else if (msg.type === "event" && msg.name === "creature_kill") this.onKill();
  }

  private onSnapshot(msg: Record<string, unknown>): void {
    const level = msg.level as { id?: string | null } | undefined;
    if (level?.id) this.currentLevel = level.id;

    const creatures = (msg.creatures as SnapshotCreature[] | undefined) ?? [];
    this.enemiesAlive = creatures.filter((c) => !c.isPlayer && c.state === "Alive").length;

    const player = msg.player as { health?: number } | undefined;
    if (player?.health !== undefined) this.playerHealth = player.health;

    const rule = this.levelRule();
    if (rule?.quiet) {
      // Safe zone: keep counters fresh but do nothing.
      this.lastEnemiesAlive = this.enemiesAlive;
      return;
    }

    // Track void-falling corpses (dead + far below the floor) for cleanup.
    if (this.config.cleanupVoidCorpses) {
      for (const c of creatures) {
        if (!c.isPlayer && c.state === "Dead" && c.pos.length === 3 && c.pos[1] < -50) {
          this.voidCorpses.set(c.instanceId, c.pos[1]);
        }
      }
    }

    // Low health potion
    const potion = this.config.lowHealthPotion;
    if (
      potion.enabled &&
      this.playerHealth > 0 &&
      this.playerHealth < potion.threshold
    ) {
      this.gate("lowHealthPotion", potion.cooldownMs, () => {
        this.log(`[gm] player at ${Math.round(this.playerHealth)} hp - dropping a potion`);
        void this.bridge
          .send("spawn_item", { itemId: "PotionHealth", relativeToPlayer: [1, 0.2, 1] })
          .catch(() => undefined);
        void this.llm?.react("lowHealth");
      });
    }

    // Wave transition bookkeeping: when enemies drop from >0 to 0, arm the
    // settle timer. Settling itself happens in tick() so it works even if
    // snapshots pause.
    const prev = this.lastEnemiesAlive;
    this.lastEnemiesAlive = this.enemiesAlive;
    if (this.enemiesAlive === 0) {
      if (prev > 0 && this.zeroSince === 0) {
        this.zeroSince = Date.now();
        this.waveSettled = false;
      }
    } else {
      this.zeroSince = 0;
      this.waveSettled = false;
    }
  }

  private onWaveEnd(): void {
    // Home has no waves - it gets burglars instead.
    if (this.currentLevel === "Home") return;
    // Only react to a wave that actually had kills since the last reaction.
    if (this.sessionKills <= this.killsAtLastWaveEnd) return;
    this.killsAtLastWaveEnd = this.sessionKills;

    this.log(
      `[gm] wave settled - session kills: ${this.sessionKills}, player health: ${Math.round(this.playerHealth)}`,
    );
    void this.llm?.react("waveEnd");
    const reward = this.config.waveEndReward;
    if (reward.enabled && this.sessionKills >= reward.minSessionKills) {
      this.gate("waveEndReward", reward.cooldownMs, () => {
        const itemId = reward.items[Math.floor(Math.random() * reward.items.length)];
        this.log(`[gm] wave reward: ${itemId}`);
        void this.bridge
          .send("spawn_item", { itemId, relativeToPlayer: [0.5, 0.2, 1] })
          .catch(() => undefined);
      });
    }
  }

  private onKill(): void {
    this.sessionKills += 1;
    if (this.levelRule()?.quiet) return;
    const streak = this.config.killStreakLog;
    if (!streak.enabled) return;

    const now = Date.now();
    this.killTimes.push(now);
    this.killTimes = this.killTimes.filter((t) => now - t <= streak.windowMs);
    if (this.killTimes.length >= streak.kills) {
      this.log(`[gm] kill streak: ${this.killTimes.length} kills in ${streak.windowMs / 1000}s`);
      this.killTimes = []; // reset so the next streak needs fresh kills
      void this.llm?.react("killStreak");
    }
  }

  private tick(): void {
    if (!this.config.enabled) return;

    const now = Date.now();
    const rule = this.levelRule();
    if (rule?.quiet) return;

    // Home: occasional burglars arriving from far away, hunting the player.
    const burglar = rule?.burglar;
    if (this.currentLevel === "Home" && burglar?.enabled && now - this.lastBurglarAt > burglar.minIntervalMs) {
      this.lastBurglarAt = now;
      this.spawnBurglars(burglar);
    }

    // Wave settle: enemies must stay at zero for a settle window (the game
    // sometimes feeds stragglers several seconds after the last kill).
    if (
      this.zeroSince > 0 &&
      !this.waveSettled &&
      now - this.zeroSince > this.config.waveSettleMs
    ) {
      this.waveSettled = true;
      this.onWaveEnd();
    }

    if (!this.config.cleanupVoidCorpses) return;
    // Throttle: at most one despawn per 500ms so cleanup never floods the game.
    for (const [instanceId] of this.voidCorpses) {
      if (now - this.lastCleanupAt < 500) break;
      this.lastCleanupAt = now;
      this.voidCorpses.delete(instanceId);
      void this.bridge
        .send("despawn_entity", { instanceId })
        .then((result) => {
          const r = result as { despawned?: boolean } | undefined;
          if (r?.despawned === true) this.log(`[gm] cleaned void corpse ${instanceId}`);
        })
        .catch(() => undefined);
    }
  }

  private levelRule(): LevelRule | undefined {
    if (!this.currentLevel) return undefined;
    return this.config.levelRules?.[this.currentLevel];
  }

  private spawnBurglars(burglar: NonNullable<LevelRule["burglar"]>): void {
    const count = 1 + Math.floor(Math.random() * Math.max(1, burglar.maxEnemies));
    const brains = ["HumanEasy", "HumanMedium"];
    const types = ["HumanMale", "HumanFemale"];
    const min = burglar.distanceMin ?? 25;
    const max = burglar.distanceMax ?? 45;

    this.log(`[gm] ${count} burglar(s) approaching from outside...`);
    for (let i = 0; i < count; i++) {
      const params = {
        creatureId: types[Math.floor(Math.random() * types.length)],
        brainId: brains[Math.floor(Math.random() * brains.length)],
        factionId: 3,
        distanceFromPlayer: Math.round(min + Math.random() * (max - min)),
        attackPlayer: true,
      };
      void this.bridge.send("spawn_creature", params).catch(() => undefined);
    }
    void this.llm?.react("burglar");
  }

  private gate(key: string, cooldownMs: number, action: () => void): void {
    const now = Date.now();
    const last = this.cooldowns.get(key) ?? 0;
    if (now - last < cooldownMs) return;
    this.cooldowns.set(key, now);
    action();
  }
}
