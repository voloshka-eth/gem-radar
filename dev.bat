@echo off
setlocal
cd /d "%~dp0"

echo [1/3] Starting Postgres + Redis...
docker compose up -d
if errorlevel 1 (
    echo ERROR: Docker Desktop is not running or docker compose failed.
    pause
    exit /b 1
)

echo [2/3] Applying safe database migrations...
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

echo [3/3] Starting Gem Radar collectors in separate terminals...
start "Gem Radar Main" cmd /k "cd /d ""%~dp0"" ^&^& npm run start:dev"
start "Gem Radar Solana" cmd /k "cd /d ""%~dp0"" ^&^& npm run start:solana"

echo Started: Gem Radar Main and Gem Radar Solana.
echo Keep their windows open. Close them with Ctrl+C when you want to stop collectors.
timeout /t 3 /nobreak >nul
endlocal
