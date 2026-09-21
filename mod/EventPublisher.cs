using System;
using System.Collections.Generic;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using ThunderRoad;
using UnityEngine;

namespace BaSMcpBridge
{
    public static class EventPublisher
    {
        // Coalescing: combat hits are frequent; send at most one per creature
        // per second to keep the event stream light.
        private static readonly Dictionary<int, float> LastHitSent = new Dictionary<int, float>();

        public static void Subscribe()
        {
            EventManager.onCreatureSpawn += OnCreatureSpawn;
            EventManager.onCreatureKill += OnCreatureKill;
            EventManager.onCreatureDespawn += OnCreatureDespawn;
            EventManager.onCreatureHit += OnCreatureHit;
            EventManager.onCreatureAttackParry += OnParry;
            EventManager.onCreatureDisarm += OnDisarm;
            EventManager.OnSpellUsed += OnSpellUsed;
            EventManager.OnItemGrab += OnItemGrab;
            EventManager.OnItemRelease += OnItemRelease;
            EventManager.onItemSpawnEquip += OnItemSpawnEquip;
            EventManager.onLiquidConsumed += OnLiquidConsumed;
            EventManager.onEdibleConsumed += OnEdibleConsumed;
            EventManager.onLevelLoad += OnLevelLoad;
            EventManager.onLevelUnload += OnLevelUnload;
        }

        public static void Unsubscribe()
        {
            EventManager.onCreatureSpawn -= OnCreatureSpawn;
            EventManager.onCreatureKill -= OnCreatureKill;
            EventManager.onCreatureDespawn -= OnCreatureDespawn;
            EventManager.onCreatureHit -= OnCreatureHit;
            EventManager.onCreatureAttackParry -= OnParry;
            EventManager.onCreatureDisarm -= OnDisarm;
            EventManager.OnSpellUsed -= OnSpellUsed;
            EventManager.OnItemGrab -= OnItemGrab;
            EventManager.OnItemRelease -= OnItemRelease;
            EventManager.onItemSpawnEquip -= OnItemSpawnEquip;
            EventManager.onLiquidConsumed -= OnLiquidConsumed;
            EventManager.onEdibleConsumed -= OnEdibleConsumed;
            EventManager.onLevelLoad -= OnLevelLoad;
            EventManager.onLevelUnload -= OnLevelUnload;
        }

        // ---------- combat perception ----------

        private static void OnCreatureHit(Creature creature, CollisionInstance collisionInstance, EventTime eventTime)
        {
            if (eventTime != EventTime.OnStart || creature == null || collisionInstance == null)
            {
                return;
            }
            try
            {
                int id = creature.GetInstanceID();
                float now = Time.time;
                if (LastHitSent.TryGetValue(id, out float last) && now - last < 1f)
                {
                    return; // coalesced
                }
                LastHitSent[id] = now;

                string source = null;
                bool sourceIsPlayer = false;
                DescribeSource(collisionInstance, out source, out sourceIsPlayer);

                string part = collisionInstance.damageStruct.hitRagdollPart != null
                    ? collisionInstance.damageStruct.hitRagdollPart.type.ToString()
                    : null;
                float damage = (float)Math.Round(collisionInstance.damageStruct.damage, 1);
                string damageType = collisionInstance.damageStruct.damageType.ToString();

                Send("hit", new JObject
                {
                    { "instanceId", id },
                    { "type", creature.creatureId ?? "?" },
                    { "isPlayer", creature.isPlayer },
                    { "damage", damage },
                    { "damageType", damageType },
                    { "part", part },
                    { "source", source ?? "environment" },
                    { "sourceIsPlayer", sourceIsPlayer },
                    { "pos", StatePublisher.Vec(creature.transform.position) }
                });
            }
            catch
            {
                // never let event handling break the stream
            }
        }

        private static void OnParry(Creature parriedCreature, Item parriedItem, Creature parryingCreature, Item parryingItem, CollisionInstance collisionInstance)
        {
            try
            {
                Send("parry", new JObject
                {
                    { "parriedId", parriedCreature != null ? parriedCreature.GetInstanceID() : 0 },
                    { "parriedType", parriedCreature != null ? (parriedCreature.creatureId ?? "?") : null },
                    { "parriedIsPlayer", parriedCreature != null && parriedCreature.isPlayer },
                    { "parriedItem", parriedItem != null ? (parriedItem.itemId ?? "?") : null },
                    { "parryingId", parryingCreature != null ? parryingCreature.GetInstanceID() : 0 },
                    { "parryingType", parryingCreature != null ? (parryingCreature.creatureId ?? "?") : null },
                    { "parryingIsPlayer", parryingCreature != null && parryingCreature.isPlayer },
                    { "parryingItem", parryingItem != null ? (parryingItem.itemId ?? "?") : null }
                });
            }
            catch
            {
            }
        }

        private static void OnDisarm(Creature creature, RagdollHand hand, Handle handle, CollisionInstance hit)
        {
            try
            {
                Send("disarm", new JObject
                {
                    { "instanceId", creature != null ? creature.GetInstanceID() : 0 },
                    { "type", creature != null ? (creature.creatureId ?? "?") : null },
                    { "isPlayer", creature != null && creature.isPlayer },
                    { "item", handle != null && handle.item != null ? (handle.item.itemId ?? "?") : null }
                });
            }
            catch
            {
            }
        }

        private static void OnSpellUsed(string spellId, Creature creature, Side side)
        {
            try
            {
                Send("spell_cast", new JObject
                {
                    { "spellId", spellId ?? "?" },
                    { "isPlayer", creature != null && creature.isPlayer },
                    { "side", side.ToString() }
                });
            }
            catch
            {
            }
        }

        // ---------- item perception ----------

        private static void OnItemGrab(Handle handle, RagdollHand ragdollHand)
        {
            try
            {
                Send("item_grab", new JObject
                {
                    { "itemId", handle != null && handle.item != null ? (handle.item.itemId ?? "?") : "?" },
                    { "isPlayer", ragdollHand != null && ragdollHand.creature != null && ragdollHand.creature.isPlayer }
                });
            }
            catch
            {
            }
        }

        private static void OnItemRelease(Handle handle, RagdollHand ragdollHand, bool throwing)
        {
            try
            {
                Send("item_release", new JObject
                {
                    { "itemId", handle != null && handle.item != null ? (handle.item.itemId ?? "?") : "?" },
                    { "isPlayer", ragdollHand != null && ragdollHand.creature != null && ragdollHand.creature.isPlayer },
                    { "throwing", throwing }
                });
            }
            catch
            {
            }
        }

        private static void OnItemSpawnEquip(Item item)
        {
            try
            {
                Send("item_spawn", new JObject
                {
                    { "instanceId", item != null ? item.GetInstanceID() : 0 },
                    { "itemId", item != null ? (item.itemId ?? "?") : "?" }
                });
            }
            catch
            {
            }
        }

        private static void OnLiquidConsumed(LiquidContainer liquidContainer, Creature consumer, EventTime eventTime)
        {
            if (eventTime != EventTime.OnStart)
            {
                return;
            }
            try
            {
                Send("liquid_consumed", new JObject
                {
                    { "itemId", liquidContainer != null && liquidContainer.item != null ? (liquidContainer.item.itemId ?? "?") : "?" },
                    { "isPlayer", consumer != null && consumer.isPlayer }
                });
            }
            catch
            {
            }
        }

        private static void OnEdibleConsumed(Item edible, Creature consumer, EventTime eventTime)
        {
            if (eventTime != EventTime.OnStart)
            {
                return;
            }
            try
            {
                Send("edible_consumed", new JObject
                {
                    { "itemId", edible != null ? (edible.itemId ?? "?") : "?" },
                    { "isPlayer", consumer != null && consumer.isPlayer }
                });
            }
            catch
            {
            }
        }

        // ---------- lifecycle ----------

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
            DescribeSource(collisionInstance, out killer, out killerIsPlayer);

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
            LastHitSent.Clear();
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
            LastHitSent.Clear();
            Send("level_unload", new JObject
            {
                { "id", levelData != null ? levelData.id : null },
                { "mode", mode != null ? mode.name : null }
            });
        }

        // ---------- helpers ----------

        private static void DescribeSource(CollisionInstance collisionInstance, out string source, out bool isPlayer)
        {
            source = null;
            isPlayer = false;
            if (collisionInstance == null || collisionInstance.sourceColliderGroup == null)
            {
                return;
            }
            CollisionHandler handler = collisionInstance.sourceColliderGroup.collisionHandler;
            if (handler == null)
            {
                return;
            }
            Creature sourceCreature = null;
            if (handler.ragdollPart != null && handler.ragdollPart.ragdoll != null)
            {
                sourceCreature = handler.ragdollPart.ragdoll.creature;
            }
            if (sourceCreature != null && sourceCreature.isPlayer)
            {
                isPlayer = true;
                source = "player";
            }
            else if (sourceCreature != null)
            {
                source = "creature:" + (sourceCreature.creatureId ?? "?");
            }
            else if (handler.item != null)
            {
                source = "item:" + (handler.item.itemId ?? "?");
            }
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
