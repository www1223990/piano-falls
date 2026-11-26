' Piano Falls launcher
' Starts the local server with a hidden window (no console at all).
' If the port is already in use, serve.ps1 just opens the page and exits,
' so double-clicking twice never starts a second server.
' Need to see the console for debugging? use 启动 Piano Falls.cmd instead.
Option Explicit

Dim sh, fso, base, cmd
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

base = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = base

cmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File """ & base & "\serve.ps1"""
sh.Run cmd, 0, False