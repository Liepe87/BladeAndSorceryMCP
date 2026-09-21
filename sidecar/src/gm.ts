import type { TcpBridge } from "./tcp-bridge.js";
import type { LlmReactor } from "./gm-llm.js";
import type { LlmConfig, LevelRule } from "./gm-llm.js";

export interface GmConfig {
  enabled: boolean;
  lootDrops: {
    enabled: boolean;
    chance: number;
    items: { id: string; weight: number }[];
  };
  killStreakLog: { enabled: boolean; kills: number; windowMs: number };
  levelRules?: Record<string, LevelRule>;
  llm?: LlmConfig;
}

export const defaultGmConfig: GmConfig = {
  enabled: true,
  lootDrops: {
    enabled: true,
    chance: 0.3,
    items: [
      { id: "PotionHealth", weight: 5 },
      { id: "SpellBombFire", weight: 3 },
      { id: "SpellBombGravity", weight: 3 },
      { id: "SpellBombLightning", weight: 3 },
      { id: "PotionRumFire", weight: 3 },
      { id: "PotionRumGravity", weight: 3 },
      { id: "PotionRumLightning", weight: 3 },
      { id: "CoinBag", weight: 4 },
      { id: "GoldCoin", weight: 6 },
      { id: "SilverCoin", weight: 6 },
      { id: "CopperCoin", weight: 8 },
      { id: "Poo", weight: 2 },
    ],
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
 *
 * Deliberately conservative: it never force-destroys creatures (that corrupts
 * the game's pool) and it relies on the game's own "wave_end" signal rather
 * than guessing from alive-counts, which fired falsely mid-wave.
 */
export class GameMaster {
  private cooldowns = new Map<string, number>();
  private killTimes: number[] = [];
  private sessionKills = 0;
  private currentLevel: string | null = null;
  private killsAtLastWaveEnd = 0;
  private lastBurglarAt = Date.now(); // grace period: no rolls right after startup

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
    else if (msg.type === "event") {
      if (msg.name === "creature_kill") {
        this.onKill((msg.data as { pos?: number[] } | undefined)?.pos);
      } else if (msg.name === "wave_end") {
        this.onWaveEnd();
      }
    }
  }

  private onSnapshot(msg: Record<string, unknown>): void {
    const level = msg.level as { id?: string | null } | undefined;
    if (level?.id) this.currentLevel = level.id;
  }

  private onWaveEnd(): void {
    if (this.levelRule()?.quiet) return;
    // Home has no waves - it gets burglars instead.
    if (this.currentLevel === "Home") return;
    // Only react to a wave that actually had kills since the last reaction.
    if (this.sessionKills <= this.killsAtLastWaveEnd) return;
    this.killsAtLastWaveEnd = this.sessionKills;

    this.announce(`Wave cleared - ${this.sessionKills} kills this session.`, 6);
    void this.llm?.react("waveEnd");
  }

  private onKill(killPos?: number[]): void {
    this.sessionKills += 1;
    if (this.levelRule()?.quiet) return;

    // Loot drops at the corpse, not at the player's feet.
    this.dropLoot(killPos);

    const streak = this.config.killStreakLog;
    if (!streak.enabled) return;

    const now = Date.now();
    this.killTimes.push(now);
    this.killTimes = this.killTimes.filter((t) => now - t <= streak.windowMs);
    if (this.killTimes.length >= streak.kills) {
      this.announce(`Kill streak: ${this.killTimes.length} kills in ${streak.windowMs / 1000}s!`, 4);
      this.killTimes = []; // reset so the next streak needs fresh kills
      void this.llm?.react("killStreak");
    }
  }

  private dropLoot(killPos?: number[]): void {
    const cfg = this.config.lootDrops;
    if (!cfg?.enabled || !killPos || killPos.length !== 3) return;

    let itemId: string | null = null;
    if (Math.random() < cfg.chance) {
      itemId = this.pickWeighted(cfg.items);
    }
    if (!itemId) return;

    // Slightly above the ground at the corpse position.
    const position = [killPos[0], killPos[1] + 0.3, killPos[2]];
    void this.bridge.send("spawn_item", { itemId, position }).catch(() => undefined);

    // Silent feature - the drop happens without in-game commentary.
    this.log(`[gm] loot drop: ${itemId}`);
  }

  private pickWeighted(items: { id: string; weight: number }[]): string | null {
    const total = items.reduce((sum, i) => sum + Math.max(0, i.weight), 0);
    if (total <= 0) return null;
    let roll = Math.random() * total;
    for (const item of items) {
      roll -= Math.max(0, item.weight);
      if (roll <= 0) return item.id;
    }
    return items[items.length - 1]?.id ?? null;
  }

  private tick(): void {
    if (!this.config.enabled) return;
    const rule = this.levelRule();
    if (rule?.quiet) return;

    // Home: occasional burglars arriving from far away, hunting the player.
    // One chance roll per cooldown window - entering Home does not guarantee
    // a break-in, and the first window after startup is always quiet.
    const burglar = rule?.burglar;
    if (this.currentLevel === "Home" && burglar?.enabled && Date.now() - this.lastBurglarAt > burglar.minIntervalMs) {
      this.lastBurglarAt = Date.now(); // one roll per window, win or lose
      if (Math.random() < (burglar.chance ?? 0.35)) {
        this.spawnBurglars(burglar);
      } else {
        this.log("[gm] home quiet tonight - no burglars");
      }
    }
  }

  private levelRule(): LevelRule | undefined {
    if (!this.currentLevel) return undefined;
    return this.config.levelRules?.[this.currentLevel];
  }

  // Logs to the console/log file AND displays the message in-game.
  private announce(text: string, duration = 5): void {
    this.log(`[gm] ${text}`);
    void this.bridge.send("show_message", { text, duration }).catch(() => undefined);
  }

  private spawnBurglars(burglar: NonNullable<LevelRule["burglar"]>): void {
    const count = 1 + Math.floor(Math.random() * Math.max(1, burglar.maxEnemies));
    const brains = ["HumanEasy", "HumanMedium"];
    const types = ["HumanMale", "HumanFemale"];
    const min = burglar.distanceMin ?? 25;
    const max = burglar.distanceMax ?? 45;

    this.announce(`You hear a door creak somewhere in the house... (${count} burglar${count > 1 ? "s" : ""})`, 5);
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
