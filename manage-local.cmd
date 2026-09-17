@echo off
setlocal
set "EKAKI_MANAGER_FROM_BATCH=1"
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\manage-local-servers.ps1" %*
set "manager_exit=%errorlevel%"
if not "%manager_exit%"=="0" set "manager_exit=1"
if not "%manager_exit%"=="0" if not "%EKAKI_MANAGER_NO_PAUSE%"=="1" pause
exit /b %manager_exit%
