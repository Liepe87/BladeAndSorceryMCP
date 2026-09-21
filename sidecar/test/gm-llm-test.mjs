// gm-llm-test.mjs — unit tests the LlmReactor with a mocked fetch (no API key).
import { LlmReactor } from "../dist/gm-llm.js";

let failures = 0;
function check(label, cond) {
  console.log(`${cond ? "PASS" : "FAIL"} ${label}`);
  if (!cond) failures++;
}

const commands = [];
const fakeChannel = {
  send: async (op, params) => {
    commands.push({ op, params });
    return { accepted: true };
  },
};
const fakeWorld = {
  aliveCount: () => 2,
  recentEvents: () => [],
  summary: () => ({
    creatures: [
      { instanceId: 7, isPlayer: true },
      { instanceId: 101, isPlayer: false },
    ],
    player: { health: 100 },
  }),
};
const fakeLimiter = { trySpawn: () => null };
const fakeLog = (m) => console.log(`  (log) ${m}`);
const config = {
  enabled: true,
  baseUrl: "https://fake",
  model: "fake",
  minIntervalMs: 0,
  triggers: ["waveEnd"],
  timeoutMs: 5000,
  maxActions: 3,
};
const guards = { limiter: fakeLimiter, maxCreatures: 20 };

function fakeFetchFor(content) {
  return async () => ({
    ok: true,
    json: async () => ({ choices: [{ message: { content } }] }),
  });
}

// 1: valid spawn action executed
commands.length = 0;
let reactor = new LlmReactor(
  fakeChannel, fakeWorld, guards, config, "test-key", fakeLog,
  fakeFetchFor('{"comment":"Reinforcements arrive!","actions":[{"tool":"spawn_creature","args":{"creatureId":"HumanMale","relativeToPlayer":[3,0,3],"brainId":"HumanHard"}}]}'),
);
await reactor.react("waveEnd");
check("valid spawn action executed", commands.some((c) => c.op === "spawn_creature" && c.params.creatureId === "HumanMale" && c.params.brainId === "HumanHard"));

// 2: player despawn refused
commands.length = 0;
reactor = new LlmReactor(
  fakeChannel, fakeWorld, guards, config, "test-key", fakeLog,
  fakeFetchFor('{"comment":"x","actions":[{"tool":"despawn_entity","args":{"instanceId":7}}]}'),
);
await reactor.react("waveEnd");
check("player despawn refused", !commands.some((c) => c.op === "despawn_entity"));

// 3: unknown tool skipped safely
commands.length = 0;
reactor = new LlmReactor(
  fakeChannel, fakeWorld, guards, config, "test-key", fakeLog,
  fakeFetchFor('{"comment":"x","actions":[{"tool":"nuke_the_world","args":{}}]}'),
);
await reactor.react("waveEnd");
check("unknown tool skipped without crashing", commands.length === 0);

// 4: code-fenced JSON with prose still parses
commands.length = 0;
reactor = new LlmReactor(
  fakeChannel, fakeWorld, guards, config, "test-key", fakeLog,
  fakeFetchFor('Here you go:\n```json\n{"comment":"Heal up!","actions":[{"tool":"spawn_item","args":{"itemId":"PotionHealth","relativeToPlayer":[1,0,1]}}]}\n```\nHope this helps!'),
);
await reactor.react("waveEnd");
check("fenced JSON parsed and executed", commands.some((c) => c.op === "spawn_item" && c.params.itemId === "PotionHealth"));

// 5: non-curated creature rejected
commands.length = 0;
reactor = new LlmReactor(
  fakeChannel, fakeWorld, guards, config, "test-key", fakeLog,
  fakeFetchFor('{"comment":"x","actions":[{"tool":"spawn_creature","args":{"creatureId":"Dragon"}}]}'),
);
await reactor.react("waveEnd");
check("non-curated creature rejected", commands.length === 0);

// 6: non-trigger ignored, API error logged without crashing
commands.length = 0;
reactor = new LlmReactor(
  fakeChannel, fakeWorld, guards, config, "test-key", fakeLog,
  async () => ({ ok: false, status: 500, text: async () => "boom" }),
);
await reactor.react("waveEnd");
check("API error handled without crashing", commands.length === 0);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
