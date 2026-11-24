@echo off
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\launch-studio.ps1" -Repo "%~dp0." %*
