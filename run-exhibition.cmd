@echo off
cd /d "%~dp0"
call npm.cmd run build:exhibition
if errorlevel 1 goto failed
call npm.cmd run start:exhibition
if errorlevel 1 goto failed
exit /b 0
:failed
echo.
echo Exhibition server could not start. Check the message above.
pause
exit /b 1
