@echo off
setlocal
set "EKAKI_MANAGER_FROM_BATCH=1"
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0cho_ekakiuta_manager.ps1" %*
set "manager_exit=%errorlevel%"
if not "%manager_exit%"=="0" if not "%EKAKI_MANAGER_NO_PAUSE%"=="1" pause
exit /b %manager_exit%
