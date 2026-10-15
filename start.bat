@echo off
REM SAQAI - start everything on Windows: double-click start.bat
REM Database (Docker) -> AI service (port 8000) -> backend + dashboard (port 3000)
cd /d "%~dp0"

if not exist backend\.env ( echo backend\.env missing: copy .env.example backend\.env and edit it & pause & exit /b 1 )
if not exist .venv ( echo Python venv missing: py -3.12 -m venv .venv ^&^& .venv\Scripts\pip install -r ai\requirements.txt & pause & exit /b 1 )
if not exist backend\node_modules ( pushd backend & call npm install & popd )
if not exist frontend\dist ( pushd frontend & call npm install & call npm run build & popd )

echo Starting database...
docker compose up -d db

echo Starting AI service (new window)...
start "SAQAI AI service" cmd /k ".venv\Scripts\uvicorn main:app --app-dir ai\service --host 0.0.0.0 --port 8000"
timeout /t 8 /nobreak >nul

echo Starting backend + dashboard...
cd backend
call npm start
