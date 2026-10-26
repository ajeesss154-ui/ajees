@echo off
cd /d "%~dp0"
echo Close the JARVIS app before continuing. Keep this installer window open.
pause
py -3.12 install_upgrade.py
if errorlevel 1 (
    echo Update did not finish. Keep the error above and send it to your assistant.
) else (
    echo Open JARVIS with its desktop shortcut, then click WORKSPACE in the top bar.
)
pause
