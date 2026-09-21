using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using ThunderRoad;

namespace BaSMcpBridge
{
    public static class EventPublisher
    {
        public static void Subscribe()
        {
            EventManager.onCreatureSpawn += OnCreatureSpawn;
            EventManager.onCreatureKill += OnCreatureKill;
            EventManager.onCreatureDespawn += OnCreatureDespawn;
            EventManager.onLevelLoad += OnLevelLoad;
            EventManager.onLevelUnload += OnLevelUnload;
        }

        public static void Unsubscribe()
        {
            EventManager.onCreatureSpawn -= OnCreatureSpawn;
            EventManager.onCreatureKill -= OnCreatureKill;
            EventManager.onCreatureDespawn -= OnCreatureDespawn;
            EventManager.onLevelLoad -= OnLevelLoad;
            EventManager.onLevelUnload -= OnLevelUnload;
        }

        private static void OnCreatureSpawn(Creature creature)
        {
            Send("creature_spawn", new JObject
            {
                { "instanceId", creature.GetInstanceID() },
                { "type", creature.creatureId ?? "?" },
                { "faction", creature.factionId },
                { "pos", StatePublisher.Vec(creature.transform.position) }
            });
        }

        private static void OnCreatureKill(Creature creature, Player player, CollisionInstance collisionInstance, EventTime eventTime)
        {
            // The game fires this event twice per kill (OnStart + OnEnd); act once.
            if (eventTime != EventTime.OnStart)
            {
                return;
            }

            // Make the corpse release its weapons immediately. The vanilla drop
            // depends on the brain having a Death module and a random delay, so
            // some deaths leave the weapon gripped forever. Force it.
            try
            {
                if (creature.handLeft != null && creature.handLeft.grabbedHandle != null)
                {
                    creature.handLeft.UnGrab(false);
                }
                if (creature.handRight != null && creature.handRight.grabbedHandle != null)
                {
                    creature.handRight.UnGrab(false);
                }
            }
            catch
            {
                // never let event handling break the kill
            }

            bool killerIsPlayer = player != null;
            string killer = null;

            if (collisionInstance != null && collisionInstance.sourceColliderGroup != null)
            {
                CollisionHandler handler = collisionInstance.sourceColliderGroup.collisionHandler;
                if (handler != null)
                {
                    Creature sourceCreature = null;
                    if (handler.ragdollPart != null && handler.ragdollPart.ragdoll != null)
                    {
                        sourceCreature = handler.ragdollPart.ragdoll.creature;
                    }

                    if (sourceCreature != null && sourceCreature.isPlayer)
                    {
                        killerIsPlayer = true;
                        killer = "player";
                    }
                    else if (sourceCreature != null)
                    {
                        killer = "creature:" + (sourceCreature.creatureId ?? "?");
                    }
                    else if (handler.item != null)
                    {
                        killer = "item:" + (handler.item.itemId ?? "?");
                    }
                }
            }

            Send("creature_kill", new JObject
            {
                { "instanceId", creature.GetInstanceID() },
                { "type", creature.creatureId ?? "?" },
                { "killer", killer ?? (killerIsPlayer ? "player" : "environment") },
                { "killerIsPlayer", killerIsPlayer },
                { "pos", StatePublisher.Vec(creature.transform.position) }
            });
        }

        private static void OnCreatureDespawn(Creature creature, EventTime eventTime)
        {
            // fires twice per despawn attempt (OnStart + OnEnd); act once
            if (eventTime != EventTime.OnStart)
            {
                return;
            }
            Send("creature_despawn", new JObject
            {
                { "instanceId", creature.GetInstanceID() },
                { "type", creature.creatureId ?? "?" }
            });
        }

        private static void OnLevelLoad(LevelData levelData, LevelData.Mode mode, EventTime eventTime)
        {
            if (eventTime != EventTime.OnStart)
            {
                return;
            }
            Send("level_load", new JObject
            {
                { "id", levelData != null ? levelData.id : null },
                { "mode", mode != null ? mode.name : null }
            });
        }

        private static void OnLevelUnload(LevelData levelData, LevelData.Mode mode, EventTime eventTime)
        {
            if (eventTime != EventTime.OnStart)
            {
                return;
            }
            Send("level_unload", new JObject
            {
                { "id", levelData != null ? levelData.id : null },
                { "mode", mode != null ? mode.name : null }
            });
        }

        private static void Send(string name, JObject data)
        {
            McpBridgeScript instance = McpBridgeScript.Instance;
            if (instance == null)
            {
                return;
            }

            var msg = new JObject
            {
                { "type", "event" },
                { "name", name },
                { "data", data }
            };
            instance.EnqueueOutbound(msg.ToString(Formatting.None));
        }
    }
}
