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
                    case "show_message":
                        result = ShowMessage(command.payload);
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
            else if (p?["distanceFromPlayer"] != null)
            {
                // Spawn far away on walkable ground (navmesh), so enemies
                // approach naturally instead of appearing next to the player.
                float distance = (float)p["distanceFromPlayer"];
                if (Player.local == null)
                {
                    throw new Exception("no player to measure distance from");
                }
                pos = ResolveDistanceSpawn(Player.local.transform.position, distance);
            }
            if (p?["rotationY"] != null)
            {
                rotationY = (float)p["rotationY"];
            }

            bool attackPlayer = p?["attackPlayer"] != null && (bool)p["attackPlayer"];
            Action<Creature> onSpawned = null;
            if (attackPlayer)
            {
                onSpawned = delegate(Creature creature)
                {
                    if (creature == null || Player.local == null)
                    {
                        return;
                    }
                    try
                    {
                        // Put the creature in combat with the player immediately,
                        // so it converges on their location.
                        creature.brain.currentTarget = Player.local.creature;
                        creature.brain.SetState(Brain.State.Combat);
                    }
                    catch
                    {
                        // non-fatal - the brain will detect the player normally
                    }
                };
            }

            data.SpawnAsync(pos, rotationY, null, true, null, onSpawned);

            return new JObject
            {
                { "accepted", true },
                { "creatureId", creatureId },
                { "factionId", factionId },
                { "brainId", data.brainId },
                { "attackPlayer", attackPlayer },
                { "position", StatePublisher.Vec(pos) }
            };
        }

        private static JObject ShowMessage(JObject p)
        {
            string text = (string)p?["text"];
            if (string.IsNullOrEmpty(text))
            {
                throw new Exception("text is required");
            }
            float duration = p?["duration"] != null ? (float)p["duration"] : 5f;

            DisplayMessage display = DisplayMessage.instance;
            if (display == null)
            {
                Debug.Log("[BaSMcp] show_message: DisplayMessage not available yet");
                return new JObject { { "shown", false } };
            }

            // Low priority (tutorials preempt), no warning sound, floats in
            // front of the head, auto-dismisses.
            var messageData = new DisplayMessage.MessageData(
                text, 1, 0f, null, null, false, true, false, false,
                MessageAnchorType.Head, null, true, duration, null, true, null);

            display.ShowMessage(messageData);
            return new JObject { { "shown", true }, { "text", text } };
        }

        // Finds a walkable point on the navmesh at roughly the given distance
        // from the origin in a random horizontal direction. Falls back to
        // closer distances so spawns never fail on small maps. Water and other
        // non-walkable areas are excluded by the navmesh.
        private static Vector3 ResolveDistanceSpawn(Vector3 origin, float distance)
        {
            for (int attempt = 0; attempt < 3; attempt++)
            {
                float d = distance / (1 << attempt);
                if (d < 2f)
                {
                    d = 2f;
                }
                float angle = UnityEngine.Random.Range(0f, 360f) * Mathf.Deg2Rad;
                Vector3 candidate = origin + new Vector3(Mathf.Cos(angle), 0f, Mathf.Sin(angle)) * d;
                UnityEngine.AI.NavMeshHit hit;
                if (UnityEngine.AI.NavMesh.SamplePosition(candidate, out hit, 8f, UnityEngine.AI.NavMesh.AllAreas))
                {
                    return hit.position;
                }
            }
            throw new Exception("no walkable ground found near the player");
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
                    return DespawnCreature(creature);
                }
            }
            foreach (Item item in Item.all)
            {
                if (item != null && item.GetInstanceID() == instanceId)
                {
                    try
                    {
                        item.Despawn(0f);
                        return new JObject { { "despawned", true }, { "kind", "item" } };
                    }
                    catch (Exception e)
                    {
                        throw new Exception("item despawn failed: " + e.Message);
                    }
                }
            }

            return new JObject { { "despawned", false } };
        }

        private static JObject DespawnCreature(Creature creature)
        {
            // Corpses that fell through the world can enter a broken state
            // where the normal despawn path throws (that's why the game keeps
            // retrying them forever). Fall back to a hard destroy.
            try
            {
                creature.Despawn(0f);
            }
            catch
            {
                try
                {
                    UnityEngine.Object.Destroy(creature.gameObject);
                    return new JObject { { "despawned", true }, { "kind", "creature" }, { "forced", true } };
                }
                catch (Exception e2)
                {
                    throw new Exception("creature despawn failed (normal and forced): " + e2.Message);
                }
            }
            return new JObject { { "despawned", true }, { "kind", "creature" } };
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
