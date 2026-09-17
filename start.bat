@echo off
chcp 65001 > nul
echo ====================================================
echo  Stock Trading System - HighWin ツールを起動しています...
echo ====================================================
cd /d %~dp0

start "" "http://localhost:3000"
node server.js
