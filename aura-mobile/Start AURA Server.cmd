@echo off
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" (
    py -3.12 -m venv .venv
    if errorlevel 1 goto failed
)
fc /b "backend\requirements.txt" ".venv\aura-requirements.txt" >nul 2>&1
if errorlevel 1 (
    ".venv\Scripts\python.exe" -m pip install -r backend\requirements.txt
    if errorlevel 1 goto failed
    copy /y "backend\requirements.txt" ".venv\aura-requirements.txt" >nul
)
if not exist ".aura.env" (
    ".venv\Scripts\python.exe" run.py --setup
    if errorlevel 1 goto failed
)
echo Local phone testing requires both devices on the same trusted Wi-Fi.
echo Use the PC's local IPv4 address on port 8787 in the development APK.
".venv\Scripts\python.exe" run.py --host 0.0.0.0
goto finished
:failed
echo Setup stopped. Keep the error above for troubleshooting.
:finished
pause
