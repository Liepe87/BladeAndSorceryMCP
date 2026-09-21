@echo off
title BaS MCP Bridge
echo Starting the MCP sidecar...
start "BaS MCP Sidecar" cmd /c ""%~dp0start-sidecar.bat""
timeout /t 3 /nobreak >nul
echo Launching Blade & Sorcery via Steam...
start "" steam://rungameid/629730
