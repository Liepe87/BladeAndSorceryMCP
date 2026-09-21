# listener.ps1 — dummy sidecar for the BaS MCP bridge (M0 test)
# Displays every line the game sends. Stop with Ctrl+C or by closing the window.
# Everything is also written to listener.log next to this script, so you can
# check what happened after a VR session.

$port = 47777
$logFile = Join-Path $PSScriptRoot 'listener.log'

function Write-Listener {
    param([string]$Message, [string]$Color = 'Gray')
    $stamped = "[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss'), $Message
    Write-Host $stamped -ForegroundColor $Color
    Add-Content -LiteralPath $logFile -Value $stamped
}

$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $port)
$listener.Start()
Write-Listener "=== session start ===" 'DarkGray'
Write-Listener "waiting on 127.0.0.1:$port - Ctrl+C to stop" 'Green'

$running = $true

try {
    while ($running) {

        # Wait for a connection using an interruptible poll (so Ctrl+C works)
        while ($running -and -not $listener.Pending()) {
            Start-Sleep -Milliseconds 250
        }
        if (-not $running) { break }

        $client = $listener.AcceptTcpClient()
        Write-Listener "game connected" 'Cyan'
        $stream = $client.GetStream()
        $reader = New-Object System.IO.StreamReader($stream)
        $connected = $true

        while ($running -and $connected) {

            # Inbound: print everything the game sends.
            # Poll(SelectRead) reports both data-available and connection-closed,
            # so disconnects are detected without blocking.
            if ($client.Client.Poll(0, [System.Net.Sockets.SelectMode]::SelectRead)) {
                if ($stream.DataAvailable) {
                    $line = $reader.ReadLine()
                    if ($null -eq $line) { $connected = $false }
                    else {
                        $msg = "[game] {0}" -f $line
                        Write-Listener $msg
                        # drain any further lines already buffered
                        while ($stream.DataAvailable) {
                            $line = $reader.ReadLine()
                            if ($null -eq $line) { $connected = $false; break }
                            $msg = "[game] {0}" -f $line
                            Write-Listener $msg
                        }
                    }
                }
                else {
                    # readable but no data waiting: the peer closed the connection
                    $connected = $false
                }
            }

            Start-Sleep -Milliseconds 50
        }

        Write-Listener "game disconnected, waiting for reconnect..." 'Yellow'
        try { $reader.Close(); $client.Close() } catch { }
    }
}
finally {
    try { $listener.Stop() } catch { }
    Write-Listener "stopped." 'Green'
}
