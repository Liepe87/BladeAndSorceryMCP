using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using ThunderRoad;
using UnityEngine;

namespace BaSMcpBridge
{
    public static class StatePublisher
    {
        private const int MaxCreaturesInSnapshot = 48;

        public static string BuildSnapshot(long seq)
        {
            JObject root = new JObject();
            root["type"] = "snapshot";
            root["seq"] = seq;
            root["gameTime"] = Mathf.Round(Time.time * 100f) / 100f;

            Level level = Level.current;
            if (level != null)
            {
                root["level"] = new JObject
                {
                    { "id", level.data != null ? level.data.id : null },
                    { "mode", level.mode.ToString() }
                };
            }

            Player player = Player.local;
            if (player != null)
            {
                root["player"] = new JObject
                {
                    { "present", true },
                    { "pos", Vec(player.transform.position) },
                    { "health", Mathf.Round(player.creature != null ? player.creature.currentHealth : 0f) }
                };
            }

            JArray arr = new JArray();
            int count = 0;
            foreach (Creature creature in Creature.allActive)
            {
                if (count >= MaxCreaturesInSnapshot)
                {
                    break;
                }
                arr.Add(Describe(creature));
                count++;
            }
            root["creatures"] = arr;

            return root.ToString(Formatting.None);
        }

        public static JObject Describe(Creature creature)
        {
            float dist = 0f;
            Player player = Player.local;
            if (player != null)
            {
                dist = Vector3.Distance(player.transform.position, creature.transform.position);
            }

            return new JObject
            {
                { "instanceId", creature.GetInstanceID() },
                { "type", creature.creatureId ?? "?" },
                { "state", creature.state.ToString() },
                { "health", Mathf.Round(creature.currentHealth) },
                { "faction", creature.factionId },
                { "isPlayer", creature.isPlayer },
                { "pos", Vec(creature.transform.position) },
                { "dist", Mathf.Round(dist * 100f) / 100f }
            };
        }

        public static JArray Vec(Vector3 v)
        {
            return new JArray
            {
                Mathf.Round(v.x * 100f) / 100f,
                Mathf.Round(v.y * 100f) / 100f,
                Mathf.Round(v.z * 100f) / 100f
            };
        }
    }
}
