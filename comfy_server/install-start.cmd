@echo off
rem Comfy App Server one-click install/start entry (double-click).
rem Arguments are passed through to install-start.ps1 (e.g. -NoBrowser).
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-start.ps1" %*
endlocal
