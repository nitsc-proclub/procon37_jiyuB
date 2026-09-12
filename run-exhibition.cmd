@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\manage-local-servers.ps1" -App Ensemble -Action Start
if errorlevel 1 goto failed
exit /b 0
:failed
echo.
echo Exhibition server could not start. Check the message above.
pause
exit /b 1
