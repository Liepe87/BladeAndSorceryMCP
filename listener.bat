@echo off
title BaS MCP Listener
echo Starting MCP bridge listener on 127.0.0.1:47777 ...
echo Game output will appear below. Ctrl+C to stop.
echo.
powershell -NoProfile -ExecutionPolicy Bypass -NoExit -File "%~dp0listener.ps1"
