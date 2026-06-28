@echo off
cd /d "%~dp0"

echo [1/3] Starting Postgres + Redis...
docker compose up -d
if %errorlevel% neq 0 (
    echo ERROR: docker compose failed. Is Docker Desktop running?
    pause
    exit /b 1
)

echo Waiting for services to be ready...
timeout /t 4 /nobreak >nul

echo [2/3] Syncing DB schema...
call npm run db:push -- --accept-data-loss
if %errorlevel% neq 0 (
    echo WARNING: db:push failed - check DB connection
    pause
    exit /b 1
)

echo [3/3] Starting app in watch mode...
npm run start:dev
