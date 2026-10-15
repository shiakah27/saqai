#!/usr/bin/env bash
# SAQAI — start everything on macOS / Linux:  ./start.sh
# Database (Docker) → AI service (port 8000) → backend + dashboard (port 3000). Ctrl+C stops all.
set -e
cd "$(dirname "$0")"

[ -f backend/.env ] || { echo "backend/.env missing: cp .env.example backend/.env and edit it"; exit 1; }
[ -d .venv ] || { echo "Python venv missing: python3 -m venv .venv && source .venv/bin/activate && pip install -r ai/requirements.txt"; exit 1; }
[ -d backend/node_modules ] || (cd backend && npm install)
[ -d frontend/dist ] || (cd frontend && npm install && npm run build)

echo "▶ database"
docker compose up -d db
until docker compose exec -T db pg_isready -q 2>/dev/null; do sleep 1; done

echo "▶ AI service"
.venv/bin/uvicorn main:app --app-dir ai/service --host 0.0.0.0 --port 8000 &
AI_PID=$!
trap 'kill $AI_PID 2>/dev/null' EXIT
until curl -s localhost:8000/health >/dev/null; do sleep 1; done

echo "▶ backend + dashboard"
cd backend && npm start
