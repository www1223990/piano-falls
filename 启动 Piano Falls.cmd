@echo off
chcp 65001 >nul
cd /d "%~dp0"
start "" powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Minimized -File "%~dp0serve.ps1"