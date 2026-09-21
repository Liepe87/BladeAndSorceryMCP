using System;
using System.Text;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using ThunderRoad;
using UnityEngine;

namespace BaSMcpBridge
{
    public static class CommandExecutor
    {
        private const int MaxCreatures = 30;

        public static string Handle(McpBridgeScript.BridgeCommand command)
        {
            bool ok = true;
            object result = null;
            string error = null;
            try
            {
                switch (command.op)
                {
                    case "ping":
                        result = new JObject
                        {
                            { "pong", true },
                            { "gameTime", Mathf.Round(Time.time * 100f) / 100f }
                        };
                        break;
                    case "get_state":
                        result = BuildState();
                        break;
                    case "spawn_creature":
                        result = SpawnCreature(command.payload);
                        break;
                    case "spawn_item":
                        result = SpawnItem(command.payload);
                        break;
                    case "despawn_entity":
                        result = DespawnEntity(command.payload);
                        break;
                    default:
                        ok = false;
                        error = "unknown op: " + command.op;
                        break;
                }
            }
            catch (Exception e)
            {
                ok = false;
                error = e.Message;
            }

            return BuildReply(command.id, ok, result, error);
        }

        private static string BuildReply(long id, bool ok, object result, string error)
        {
            var sb = new StringBuilder(256);
            sb.Append("{\"type\":\"reply\",\"id\":").Append(id).Append(",\"ok\":").Append(ok ? "true" : "false");
            sb.Append(ok ? ",\"result\":" : ",\"error\":");
            sb.Append(JsonConvert.SerializeObject(ok ? result : (object)error));
            sb.Append("}");
            return sb.ToString();
        }

        // ---------- ops ----------

        private static JObject SpawnCreature(JObject p)
        {
            string creatureId = (string)p?["creatureId"];
            if (string.IsNullOrEmpty(creatureId))
            {
                throw new Exception("creatureId is required");
            }

            if (Creature.allActive.Count >= MaxCreatures)
            {
                throw new Exception("spawn cap reached (" + MaxCreatures + " creatures active)");
            }

            CreatureData template = Catalog.GetData<CreatureData>(creatureId, true);
            if (template == null)
            {
                throw new Exception("unknown creatureId: " + creatureId);
            }

            CreatureData data = template.Clone() as CreatureData;
            int factionId = p?["factionId"] != null ? (int)p["factionId"] : 3;
            string brainId = p?["brainId"] != null ? (string)p["brainId"] : null;
            string containerId = p?["containerId"] != null ? (string)p["containerId"] : null;

            data.factionId = factionId;
            data.brainId = string.IsNullOrEmpty(brainId) || brainId == "None" ? "HumanDummy" : brainId;
            if (!string.IsNullOrEmpty(containerId) && containerId != "None")
            {
                data.containerID = containerId;
            }

            Vector3 pos = Player.local != null
                ? Player.local.head.transform.position + Player.local.head.transform.forward * 2f
                : Vector3.zero;
            float rotationY = Player.local != null
                ? Player.local.head.transform.rotation.eulerAngles.y + 180f
                : 0f;

            if (p?["position"] is JArray posArr && posArr.Count == 3)
            {
                pos = new Vector3((float)posArr[0], (float)posArr[1], (float)posArr[2]);
            }
            if (p?["rotationY"] != null)
            {
                rotationY = (float)p["rotationY"];
            }

            data.SpawnAsync(pos, rotationY, null, true, null, null);

            return new JObject
            {
                { "accepted", true },
                { "creatureId", creatureId },
                { "factionId", factionId },
                { "brainId", data.brainId },
                { "position", StatePublisher.Vec(pos) }
            };
        }

        private static JObject SpawnItem(JObject p)
        {
            string itemId = (string)p?["itemId"];
            if (string.IsNullOrEmpty(itemId))
            {
                throw new Exception("itemId is required");
            }

            ItemData data = Catalog.GetData<ItemData>(itemId, true);
            if (data == null)
            {
                throw new Exception("unknown itemId: " + itemId);
            }

            Vector3 pos = Player.local != null
                ? Player.local.head.transform.position + Player.local.head.transform.forward * 2f
                : Vector3.zero;
            if (p?["position"] is JArray posArr && posArr.Count == 3)
            {
                pos = new Vector3((float)posArr[0], (float)posArr[1], (float)posArr[2]);
            }

            bool owned = p?["owned"] != null && (bool)p["owned"];
            Item.Owner owner = owned ? Item.Owner.Player : Item.Owner.None;

            data.SpawnAsync(null, pos, null, null, true, null, owner);

            return new JObject
            {
                { "accepted", true },
                { "itemId", itemId },
                { "owned", owned },
                { "position", StatePublisher.Vec(pos) }
            };
        }

        private static JObject DespawnEntity(JObject p)
        {
            if (!(p?["instanceId"] is JToken idTok))
            {
                throw new Exception("instanceId is required");
            }
            int instanceId = (int)idTok;

            foreach (Creature creature in Creature.all)
            {
                if (creature != null && creature.GetInstanceID() == instanceId)
                {
                    creature.Despawn(0f);
                    return new JObject { { "despawned", true }, { "kind", "creature" } };
                }
            }
            foreach (Item item in Item.all)
            {
                if (item != null && item.GetInstanceID() == instanceId)
                {
                    item.Despawn(0f);
                    return new JObject { { "despawned", true }, { "kind", "item" } };
                }
            }

            return new JObject { { "despawned", false } };
        }

        private static JObject BuildState()
        {
            var obj = new JObject();

            Level level = Level.current;
            if (level != null)
            {
                obj["level"] = new JObject
                {
                    { "id", level.data != null ? level.data.id : null },
                    { "mode", level.mode != null ? level.mode.name : null }
                };
            }

            Player player = Player.local;
            if (player != null)
            {
                obj["player"] = new JObject
                {
                    { "present", true },
                    { "pos", StatePublisher.Vec(player.transform.position) },
                    { "health", Mathf.Round(player.creature != null ? player.creature.currentHealth : 0f) }
                };
            }

            var arr = new JArray();
            foreach (Creature creature in Creature.allActive)
            {
                arr.Add(StatePublisher.Describe(creature));
            }
            obj["creatures"] = arr;

            return obj;
        }
    }
}
