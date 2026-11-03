@echo off
chcp 65001 >nul
cd /d "%~dp0"
rem Harden state/ ACLs (Windows needs WRITE_DAC; the directory owner normally has it,
rem so no UAC prompt in the usual case). This NEVER blocks startup: if it cannot get
rem permission it prints a copy-pasteable command and exits 0.
rem See docs/guides/SECURITY_BASELINE.md ("secrets at rest").
node scripts\harden-state-acl.mjs --quiet
:loop
rem DSH Desktop picks a random port on every launch (issue #56): re-sync dsh.baseUrl
rem before each start. This never blocks startup - if DSH is not up yet the script
rem prints why and exits, and the bridge below starts anyway.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0sync-dsh-port.ps1" -NoPause
node "%~dp0src\bridge.js"
set code=%errorlevel%
if "%code%"=="2" (
    echo [%date% %time%] bridge already running in another window. Exiting.
    pause
    exit /b 2
)
echo [%date% %time%] bridge exited (code %code%), restarting in 5 seconds...
timeout /t 5 /nobreak >nul
goto loop
