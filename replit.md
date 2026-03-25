# Hamsa Eval

An evaluation and benchmarking platform for voice-based AI agents using the Hamsa AI ecosystem.

## Project Overview

Hamsa Eval lets you create Projects linked to Hamsa voice agents, define evaluation criteria (deterministic, structural, LLM-based, latency, word accuracy), run test calls, and analyze performance across different LLM models.

## Architecture

- **Frontend**: React 19 + Vite 8 + TypeScript on port 5000
- **Backend**: Express.js + TypeScript + Prisma on port 3001
- **Database**: PostgreSQL (Replit managed)
- **Queue**: BullMQ with Redis (optional; falls back to inline if Redis unavailable)
- **Package Manager**: npm (separate for frontend and backend)

## Directory Structure

```
.
├── backend/
│   ├── prisma/          # Schema + migrations
│   ├── src/
│   │   ├── app.ts       # Express entry point (port 3001)
│   │   ├── routes/      # API routes (projects, runs, labels, webhooks)
│   │   ├── services/    # Business logic (evaluator, hamsaApi, llmJudge, evaluationRunner)
│   │   └── jobs/        # BullMQ background workers
│   └── package.json
└── frontend/
    ├── src/
    │   ├── api/          # API client (relative URLs, proxied to backend via Vite)
    │   ├── components/   # Reusable UI components
    │   └── pages/        # Page components (Projects, ProjectDetail, RunDetail, Compare)
    ├── vite.config.ts    # Vite config: port 5000, proxy /api -> localhost:3001
    └── package.json
```

## Key Configuration

- Frontend Vite dev server: `0.0.0.0:5000`, `allowedHosts: true` (for Replit proxy)
- Frontend API calls use relative `/api` prefix, proxied by Vite to `localhost:3001`
- Backend uses `localhost:3001`
- Database URL from `DATABASE_URL` env var (Replit managed PostgreSQL)

## Workflows

- **Start application**: `cd frontend && npm run dev` (port 5000, webview)
- **Backend API**: `cd backend && npm run dev` (port 3001, console)

## Required Secrets

- `OPENAI_API_KEY` — for LLM Judge evaluations
- Hamsa API keys are stored per-project in the database

## Development Commands

```bash
# Backend
cd backend && npm run dev         # Start dev server
cd backend && npm run db:migrate  # Run migrations
cd backend && npm run db:generate # Regenerate Prisma client

# Frontend
cd frontend && npm run dev        # Start dev server
cd frontend && npm run build      # Production build
```
