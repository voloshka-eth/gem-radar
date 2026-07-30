@echo off
setlocal EnableExtensions
cd /d "%~dp0"
set "MAIN_PORT=3000"

echo [1/4] Checking Docker Desktop...
call :ensure_docker
if errorlevel 1 (
    echo ERROR: Docker Desktop did not become ready within 120 seconds.
    pause
    exit /b 1
)

echo [2/4] Starting healthy Postgres + Redis...
docker compose up -d --wait postgres redis
if errorlevel 1 (
    echo ERROR: Postgres or Redis failed to become healthy.
    pause
    exit /b 1
)

echo [3/4] Stopping the previous Gem Radar Main, if it is running...
call :stop_existing_main
if errorlevel 1 (
    echo ERROR: Port %MAIN_PORT% is occupied by a non-Node process. Close it, then rerun dev.bat.
    pause
    exit /b 1
)

echo [4/4] Preparing database and compiled runtime...
call npm.cmd run db:migrate:deploy
if errorlevel 1 (
    echo ERROR: Database migrations failed. Check DATABASE_URL in .env.
    pause
    exit /b 1
)

call npm.cmd run db:generate
if errorlevel 1 (
    echo WARNING: Prisma Client is locked by an already-running Node process.
    echo Continuing with the existing generated client. Stop old runtimes and rerun dev.bat after Prisma schema changes.
)

call npm.cmd run build
if errorlevel 1 (
    echo ERROR: Build failed. Fix the TypeScript errors before starting collectors.
    pause
    exit /b 1
)

echo Starting Gem Radar Main in a separate terminal...
start "Gem Radar Main" /D "%~dp0" cmd.exe /d /k "call npm.cmd run start:prod"
if errorlevel 1 (
    echo ERROR: Failed to open the Gem Radar Main terminal.
    pause
    exit /b 1
)

echo Started compiled Gem Radar Main for Ethereum and Robinhood.
echo Code changes require restarting dev.bat. Use npm run start:dev only for active debugging.
echo Keep the Gem Radar Main window open. Close it with Ctrl+C when you want to stop collectors.
ping 127.0.0.1 -n 4 >nul
endlocal
exit /b 0

:stop_existing_main
set "MAIN_PID="
for /f "tokens=5" %%P in ('netstat -ano ^| findstr /R /C:":%MAIN_PORT% .*LISTENING"') do set "MAIN_PID=%%P"
if not defined MAIN_PID exit /b 0

tasklist /FI "PID eq %MAIN_PID%" /FI "IMAGENAME eq node.exe" /NH | findstr /I "node.exe" >nul
if errorlevel 1 exit /b 1

echo Stopping previous Gem Radar Main (PID %MAIN_PID%)...
taskkill /PID %MAIN_PID% /T /F >nul 2>&1
for /l %%I in (1,1,10) do (
    netstat -ano | findstr /R /C:":%MAIN_PORT% .*LISTENING" >nul || exit /b 0
    ping 127.0.0.1 -n 2 >nul
)
exit /b 1

:ensure_docker
docker info >nul 2>&1
if not errorlevel 1 exit /b 0

set "DOCKER_DESKTOP=C:\Program Files\Docker\Docker\Docker Desktop.exe"
if not exist "%DOCKER_DESKTOP%" (
    echo ERROR: Docker Desktop was not found at "%DOCKER_DESKTOP%".
    exit /b 1
)

echo Docker Desktop is not ready. Starting it now...
start "" "%DOCKER_DESKTOP%"

for /l %%I in (1,1,60) do (
    docker info >nul 2>&1 && exit /b 0
    ping 127.0.0.1 -n 3 >nul
)

exit /b 1
