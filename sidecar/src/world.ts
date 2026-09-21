export interface CreatureState {
  instanceId: number;
  type: string;
  state: string;
  health: number;
  faction: number;
  isPlayer: boolean;
  pos: number[];
  dist: number;
}

export interface PlayerState {
  present: boolean;
  pos?: number[];
  health?: number;
}

export interface LevelState {
  id?: string | null;
  mode?: string | null;
}

export class WorldModel {
  connected = false;
  gameVersion?: string;
  level: LevelState | null = null;
  player: PlayerState | null = null;
  creatures = new Map<number, CreatureState>();
  lastSnapshotAt = 0;
  lastSeq = -1;
  private eventLog: { t: number; name: string; data: unknown }[] = [];

  apply(msg: Record<string, unknown>): void {
    switch (msg.type) {
      case "hello":
        this.connected = true;
        this.gameVersion = typeof msg.gameVersion === "string" ? msg.gameVersion : undefined;
        break;

      case "snapshot": {
        this.lastSnapshotAt = Date.now();
        this.lastSeq = typeof msg.seq === "number" ? msg.seq : this.lastSeq;
        if (msg.level !== undefined) this.level = (msg.level as LevelState) ?? null;
        if (msg.player !== undefined) this.player = (msg.player as PlayerState) ?? null;
        if (Array.isArray(msg.creatures)) {
          this.creatures.clear();
          for (const c of msg.creatures as CreatureState[]) {
            this.creatures.set(c.instanceId, c);
          }
        }
        break;
      }

      case "event": {
        const name = typeof msg.name === "string" ? msg.name : "?";
        this.eventLog.push({ t: Date.now(), name, data: msg.data });
        if (this.eventLog.length > 500) this.eventLog.shift();
        this.applyEvent(name, (msg.data ?? {}) as Record<string, unknown>);
        break;
      }
    }
  }

  private applyEvent(name: string, data: Record<string, unknown>): void {
    const instanceId = typeof data.instanceId === "number" ? data.instanceId : null;
    switch (name) {
      case "creature_spawn":
        if (instanceId !== null) {
          this.creatures.set(instanceId, {
            instanceId,
            type: (data.type as string) ?? "?",
            state: "Alive",
            health: -1,
            faction: (data.faction as number) ?? -1,
            isPlayer: false,
            pos: (data.pos as number[]) ?? [],
            dist: -1,
          });
        }
        break;
      case "creature_kill":
        if (instanceId !== null) {
          const c = this.creatures.get(instanceId);
          if (c) c.state = "Dead";
        }
        break;
      case "creature_despawn":
        if (instanceId !== null) this.creatures.delete(instanceId);
        break;
      case "level_load":
        this.level = { id: (data.id as string) ?? null, mode: (data.mode as string) ?? null };
        this.creatures.clear();
        break;
      case "level_unload":
        this.level = null;
        this.creatures.clear();
        break;
    }
  }

  aliveCount(): number {
    let n = 0;
    for (const c of this.creatures.values()) {
      if (c.state === "Alive") n++;
    }
    return n;
  }

  recentEvents(count: number): { t: number; name: string; data: unknown }[] {
    return this.eventLog.slice(-count);
  }

  summary(): Record<string, unknown> {
    return {
      connected: this.connected,
      gameVersion: this.gameVersion ?? null,
      level: this.level,
      player: this.player,
      creatureCount: this.creatures.size,
      creatures: [...this.creatures.values()],
      lastSnapshotAgeMs: this.lastSnapshotAt ? Date.now() - this.lastSnapshotAt : null,
      lastSeq: this.lastSeq,
      recentEvents: this.eventLog.slice(-20),
    };
  }
}
