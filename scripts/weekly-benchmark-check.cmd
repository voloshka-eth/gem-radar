@echo off
setlocal EnableExtensions
rem Weekly decision-gate check (plan: "Шлях до прибутковості на безкоштовних RPC").
rem Runs benchmark:robinhood-entry against the local DB and archives the report to
rem logs\weekly-benchmark\. Read the report bottom-up:
rem   1. selection/holdout counters — collection pace (target: ~5x experimentCreated
rem      per week vs pre-fix; if not, the free-RPC path is exhausted → paid RPC talk)
rem   2. status + bootstrapLower95 — the gate: lower95 > 0 on holdout AND stress
rem      => raise bankroll allocation; otherwise once samples complete => kill lane.
cd /d "%~dp0.."
if not exist "logs\weekly-benchmark" mkdir "logs\weekly-benchmark"
for /f %%i in ('powershell -NoProfile -Command "Get-Date -Format yyyy-MM-dd"') do set "STAMP=%%i"
call npm.cmd run benchmark:robinhood-entry > "logs\weekly-benchmark\benchmark-%STAMP%.log" 2>&1
echo Report written to logs\weekly-benchmark\benchmark-%STAMP%.log
endlocal
