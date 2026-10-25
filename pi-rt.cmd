@echo off
rem pi-runtime launcher: works from any directory, keeps the project as cwd.
rem usage:  pi-rt doctor | pi-rt login | pi-rt ask "..." | pi-rt list | pi-rt worker
setlocal
rem node is installed per-user; fall back to it when PATH is stale (fresh shells, shortcuts)
where node >nul 2>nul
if errorlevel 1 set "PATH=%LOCALAPPDATA%\nodejs;%PATH%"
rem UTF-8 console so Chinese prompts/output survive cmd.exe
chcp 65001 >nul 2>nul
cd /d "%~dp0"
node src\cli.ts %*
