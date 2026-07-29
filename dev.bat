@echo off
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0"

echo [0/4] Checking Docker Desktop...
docker info >nul 2>&1
if not errorlevel 1 goto docker_ready

if not exist "C:\Program Files\Docker\Docker\Docker Desktop.exe" goto docker_missing

echo Docker Desktop is not running. Starting it now...
start "" "C:\Program Files\Docker\Docker\Docker Desktop.exe"
set /a DOCKER_WAIT_SECONDS=0

:wait_for_docker
powershell -NoProfile -Command "Start-Sleep -Seconds 2"
docker info >nul 2>&1
if not errorlevel 1 goto docker_ready
set /a DOCKER_WAIT_SECONDS+=2
if !DOCKER_WAIT_SECONDS! GEQ 120 goto docker_timeout
goto wait_for_docker

:docker_ready
echo [1/4] Starting Postgres + Redis...
docker compose up -d
if errorlevel 1 (
    echo ERROR: docker compose failed.
    pause
    exit /b 1
)

echo [2/4] Applying safe database migrations...
call npx prisma migrate deploy
if errorlevel 1 (
    echo ERROR: Database migrations failed. Check Docker and DATABASE_URL in .env.
    pause
    exit /b 1
)

call npx prisma generate
if errorlevel 1 (
    echo ERROR: Prisma client generation failed. Stop running Node processes, then run dev.bat again.
    pause
    exit /b 1
)

echo [3/4] Building the production runtime...
call npm.cmd run build
if errorlevel 1 (
    echo ERROR: Gem Radar build failed.
    pause
    exit /b 1
)

echo [4/4] Starting Gem Radar...
start "Gem Radar" /D "%~dp0" cmd.exe /k call npm.cmd run start:prod

echo Started: Gem Radar Main with EVM and Solana collectors.
echo Keep the Gem Radar window open. Close it with Ctrl+C when you want to stop collectors.
powershell -NoProfile -Command "Start-Sleep -Seconds 3"
endlocal
exit /b 0

:docker_missing
echo ERROR: Docker Desktop is not installed in the expected location.
pause
exit /b 1

:docker_timeout
echo ERROR: Docker Desktop did not become ready within 120 seconds.
pause
exit /b 1
