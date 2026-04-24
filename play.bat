@echo off
title NanoHacker
set PORT=8000

echo.
echo  ███╗   ██╗ █████╗ ███╗  ██╗ ██████╗ ██╗  ██╗ █████╗  ██████╗██╗  ██╗███████╗██████╗
echo  ████╗  ██║██╔══██╗████╗ ██║██╔═══██╗██║  ██║██╔══██╗██╔════╝██║ ██╔╝██╔════╝██╔══██╗
echo  ██╔██╗ ██║███████║██╔██╗██║██║   ██║███████║███████║██║     █████╔╝ █████╗  ██████╔╝
echo  ██║╚██╗██║██╔══██║██║╚████║██║   ██║██╔══██║██╔══██║██║     ██╔═██╗ ██╔══╝  ██╔══██╗
echo  ██║ ╚████║██║  ██║██║ ╚███║╚██████╔╝██║  ██║██║  ██║╚██████╗██║  ██╗███████╗██║  ██║
echo  ╚═╝  ╚═══╝╚═╝  ╚═╝╚═╝  ╚══╝ ╚═════╝ ╚═╝  ╚═╝╚═╝  ╚═╝ ╚═════╝╚═╝  ╚═╝╚══════╝╚═╝  ╚═╝
echo.
echo  Launching on http://localhost:%PORT% ...
echo  Close this window to stop the server.
echo.

:: ── Try Python (py launcher, then python, then python3) ─────────────────────
where py >nul 2>&1
if %ERRORLEVEL% EQU 0 (
    start "" "http://localhost:%PORT%"
    py -m http.server %PORT%
    goto :done
)

where python >nul 2>&1
if %ERRORLEVEL% EQU 0 (
    start "" "http://localhost:%PORT%"
    python -m http.server %PORT%
    goto :done
)

where python3 >nul 2>&1
if %ERRORLEVEL% EQU 0 (
    start "" "http://localhost:%PORT%"
    python3 -m http.server %PORT%
    goto :done
)

:: ── Try Node.js (npx serve) ──────────────────────────────────────────────────
where npx >nul 2>&1
if %ERRORLEVEL% EQU 0 (
    set PORT=3000
    start "" "http://localhost:3000"
    npx --yes serve . -p 3000 -s
    goto :done
)

:: ── Nothing found ────────────────────────────────────────────────────────────
echo  ERROR: No suitable server found.
echo.
echo  Install one of the following, then try again:
echo    Python  https://www.python.org/downloads/
echo    Node.js https://nodejs.org/
echo.
pause
exit /b 1

:done
