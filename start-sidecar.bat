@echo off
title BaS MCP Sidecar
echo Starting the MCP sidecar (TCP bridge on 127.0.0.1:47777, MCP over stdio)...
echo Game traffic will appear below. Close the window or Ctrl+C to stop.
echo.
cd /d "%~dp0sidecar"
set BASMCP_VERBOSE=1
node dist\main.js
echo.
echo Sidecar exited. Press any key to close.
pause >nul
