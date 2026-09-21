using System;
using System.Collections.Concurrent;
using System.IO;
using System.Net.Sockets;
using System.Text;
using System.Threading;
using Newtonsoft.Json.Linq;
using ThunderRoad;
using UnityEngine;

namespace BaSMcpBridge
{
    public class McpBridgeScript : ThunderScript
    {
        public static McpBridgeScript Instance { get; private set; }

        private const string Host = "127.0.0.1";
        private const int Port = 47777;
        private const string ModVersion = "0.3.0";
        private const string GameVersion = "1.3.1";
        private const int MaxCommandsPerFrame = 8;
        private const float SnapshotInterval = 0.5f;

        private Thread _netThread;
        private volatile bool _running;
        private TcpClient _client;

        private readonly ConcurrentQueue<BridgeCommand> _commands = new ConcurrentQueue<BridgeCommand>();
        private readonly ConcurrentQueue<string> _outbound = new ConcurrentQueue<string>();
        private readonly ConcurrentQueue<string> _logs = new ConcurrentQueue<string>();

        private long _seq;
        private float _lastSnapshotTime;

        public struct BridgeCommand
        {
            public long id;
            public string op;
            public JObject payload;
        }

        // ---------- ThunderScript lifecycle ----------

        public override void ScriptLoaded(ModManager.ModData modData)
        {
            Instance = this;
        }

        public override void ScriptEnable()
        {
            _running = true;
            EventPublisher.Subscribe();
            _netThread = new Thread(NetLoop) { IsBackground = true, Name = "BaSMcpNet" };
            _netThread.Start();
            Log("enabled, connecting to " + Host + ":" + Port);
        }

        public override void ScriptDisable()
        {
            _running = false;
            EventPublisher.Unsubscribe();
            TryClose();
        }

        public override void ScriptUnload()
        {
            _running = false;
            EventPublisher.Unsubscribe();
            TryClose();
            Instance = null;
        }

        public override void ScriptUpdate()
        {
            // Logs (main thread only)
            int drained = 0;
            while (drained < 64 && _logs.TryDequeue(out string logLine))
            {
                Debug.Log(logLine);
                drained++;
            }

            // Commands from the sidecar (main thread only - Unity API access)
            drained = 0;
            while (drained < MaxCommandsPerFrame && _commands.TryDequeue(out BridgeCommand command))
            {
                string reply = CommandExecutor.Handle(command);
                if (reply != null)
                {
                    _outbound.Enqueue(reply);
                }
                drained++;
            }

            // Periodic world snapshot
            if (Time.time - _lastSnapshotTime >= SnapshotInterval)
            {
                _lastSnapshotTime = Time.time;
                _outbound.Enqueue(StatePublisher.BuildSnapshot(_seq++));
            }
        }

        // ---------- helpers (called from any thread) ----------

        public void EnqueueOutbound(string line)
        {
            _outbound.Enqueue(line);
        }

        private void Log(string message)
        {
            _logs.Enqueue("[BaSMcp] " + message);
        }

        private void TryParseCommand(string line)
        {
            try
            {
                JObject obj = JObject.Parse(line);
                JToken idTok = obj["id"];
                JToken opTok = obj["op"];
                if (idTok != null && opTok != null)
                {
                    var command = new BridgeCommand
                    {
                        id = (long)idTok,
                        op = (string)opTok,
                        payload = obj["params"] as JObject
                    };
                    _commands.Enqueue(command);
                }
                else
                {
                    Log("ignoring non-command message: " + ((string)obj["type"] ?? "?"));
                }
            }
            catch (Exception e)
            {
                Log("bad JSON from sidecar: " + e.Message);
            }
        }

        private void NetLoop()
        {
            while (_running)
            {
                try
                {
                    _client = new TcpClient();
                    _client.Connect(Host, Port);
                    using (var stream = _client.GetStream())
                    using (var writer = new StreamWriter(stream, new UTF8Encoding(false)) { AutoFlush = true })
                    using (var reader = new StreamReader(stream, Encoding.UTF8))
                    {
                        // Poll for inbound data at 500ms intervals so outbound
                        // (snapshots, events, replies) flows even when the
                        // sidecar has nothing to say.
                        stream.ReadTimeout = 500;

                        Log("connected");
                        writer.WriteLine("{\"type\":\"hello\",\"modVersion\":\"" + ModVersion + "\",\"gameVersion\":\"" + GameVersion + "\"}");

                        long lastBeat = 0;
                        while (_running)
                        {
                            string line = null;
                            try
                            {
                                line = reader.ReadLine();
                            }
                            catch (IOException)
                            {
                                // read timeout: nothing inbound - just an opportunity to send
                            }

                            if (line != null && line.Length > 0)
                            {
                                TryParseCommand(line);
                            }

                            while (_outbound.TryDequeue(out string outLine))
                            {
                                writer.WriteLine(outLine);
                            }

                            long now = Environment.TickCount;
                            if (now - lastBeat > 1000)
                            {
                                try
                                {
                                    writer.WriteLine("{\"type\":\"heartbeat\",\"seq\":" + (_seq++) + "}");
                                    lastBeat = now;
                                }
                                catch (IOException)
                                {
                                    break; // connection lost
                                }
                            }
                        }
                    }
                }
                catch (Exception e)
                {
                    Log("connection failed: " + e.Message);
                }
                finally
                {
                    TryClose();
                }

                Thread.Sleep(2000); // reconnect backoff
            }
        }

        private void TryClose()
        {
            try
            {
                if (_client != null)
                {
                    _client.Close();
                }
            }
            catch
            {
            }
        }
    }
}

