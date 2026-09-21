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

        private static JObject BuildState()
        {
            var obj = new JObject();

            Level level = Level.current;
            if (level != null)
            {
                obj["level"] = new JObject
                {
                    { "id", level.data != null ? level.data.id : null },
                    { "mode", level.mode.ToString() }
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
