import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface Allowlist {
  creatures: string[];
  items: string[];
}

// Loads the catalog allowlist (generated from the game's bas.jsondb).
// Override the path with BASMCP_ALLOWLIST (used by tests).
export function loadAllowlist(): Allowlist {
  const defaultPath = join(dirname(fileURLToPath(import.meta.url)), "..", "catalog", "allowlist.json");
  const path = process.env.BASMCP_ALLOWLIST ?? defaultPath;
  const raw = JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
  return {
    creatures: Array.isArray(raw.creatures) ? (raw.creatures as string[]) : [],
    items: Array.isArray(raw.items) ? (raw.items as string[]) : [],
  };
}

// Token-bucket rate limiter for spawn commands. Enforced per sidecar process;
// the mod also has its own hard creature cap as defense in depth.
export class SpawnLimiter {
  private tokens: number;
  private lastRefill = Date.now();
  private lastSpawn = 0;

  constructor(
    private maxPerMinute: number,
    private minIntervalMs: number,
  ) {
    this.tokens = maxPerMinute;
  }

  // Returns an error string when the spawn should be rejected, null when allowed.
  trySpawn(): string | null {
    const now = Date.now();
    const refill = ((now - this.lastRefill) / 60000) * this.maxPerMinute;
    this.tokens = Math.min(this.maxPerMinute, this.tokens + refill);
    this.lastRefill = now;
    if (this.tokens < 1) return "spawn rate limit reached";
    if (now - this.lastSpawn < this.minIntervalMs) return "spawns too close together";
    this.tokens -= 1;
    this.lastSpawn = now;
    return null;
  }
}
