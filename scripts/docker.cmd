@echo off
setlocal

REM Simple wrapper for Windows users
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0docker.ps1" %*
