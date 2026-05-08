# Hamsa Eval — Platform Documentation

> Voice AI agent evaluation platform. Ingests calls from [Hamsa](https://tryhamsa.com), runs multi-layer quality and compliance analysis, and surfaces actionable insights.

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Data Flow](#data-flow)
3. [Layered Evaluation System](#layered-evaluation-system)
4. [Other Evaluation Criteria](#other-evaluation-criteria)
5. [Cost Summary](#cost-summary)
6. [Backend: Routes & Services](#backend-routes--services)
7. [Frontend: Pages & Features](#frontend-pages--features)
8. [Database Schema](#database-schema)
9. [Authentication & Security](#authentication--security)
10. [External Integrations](#external-integrations)
11. [Queue & Worker System](#queue--worker-system)

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        Frontend (React + Vite)                  │
│  Projects · Dashboard · RunDetail · Analyses · Reports · Users  │
└───────────────────────────┬─────────────────────────────────────┘
                            │ REST API (Bearer JWT)
┌───────────────────────────▼─────────────────────────────────────┐
│                     Backend (Express + TypeScript)               │
│                                                                  │
│  Routes:  auth · projects · runs · webhooks · history · labels   │
│  Services: evaluator · layeredEvaluator · llmJudge · hamsaApi    │
│            projectAnalyzer · reportingService · promptAuditor    │
│  Queue:   BullMQ (Redis) — fallback to inline if Redis offline   │
│  DB:      PostgreSQL (Prisma ORM)                                │
└──────┬──────────────────────────────────┬───────────────────────┘
       │                                  │
       ▼                                  ▼
┌──────────────┐                 ┌─────────────────┐
│  Hamsa API   │                 │   OpenAI API    │
│  (voice AI)  │                 │  (GPT-4.1 /    │
│              │                 │   GPT-4.1-mini) │
└──────────────┘                 └─────────────────┘
```

**Tech stack:** React 18 + Vite (frontend), Express + TypeScript (backend), PostgreSQL + Prisma (DB), BullMQ + Redis (queue), OpenAI GPT-4.1 family (LLM evaluation).

---

## Data Flow

### Call Ingestion → Evaluation → Dashboard

```
1. INGESTION (one of three paths)
   ├─ WEBHOOK:  Hamsa sends call_end event → POST /api/webhooks/hamsa/:projectId
   ├─ HISTORY:  User imports past calls → POST /api/history/:projectId/import
   └─ LIVE:     User creates run manually → POST /api/runs

2. HYDRATION
   Run created as PENDING
     → Fetch conversation from Hamsa API (transcript, metadata, outcome)
     → Fetch call log from Hamsa API (node execution events, tool calls)
     → Store in Run record (transcript, callLog, webhookData, outcomeResult)
     → Status → AWAITING_DATA or ready for evaluation

3. EVALUATION (via BullMQ queue or inline fallback)
   Run status → EVALUATING
     → evaluateRun(runId) iterates project criteria
     → Each criterion routed by type to specialized evaluator
     → Results upserted into EvalResult table
     → overallScore computed as weighted average
     → Run status → COMPLETE, evalCost accumulated

4. DASHBOARD
   GET /api/projects/:id/dashboard returns aggregated KPIs:
     → Quality avg, Compliance avg, Pass rate, Objective rate
     → Score trend (daily/hourly), Outcome distribution, Sentiment
     → Node performance, Top issues, Criteria performance
```

### Transcript Resolution Priority

When evaluating, the system resolves the transcript from multiple possible sources:

| Priority | Source | Origin |
|----------|--------|--------|
| 1 | `run.transcript` | Stored during webhook/hydration |
| 2 | `run.webhookData` | Full conversation object, parsed via `extractTranscriptFromConversation()` |
| 3 | `run.callLog` | Execution logs, parsed via `extractTranscriptFromCallLog()` |

---

## Layered Evaluation System

The layered evaluation (`LAYERED_EVALUATION` criterion type) is the most sophisticated evaluator. Instead of one monolithic LLM call, it breaks analysis into focused layers.

### Layer Overview

| Layer | Name | Type | Model | Cost | What it Measures |
|-------|------|------|-------|------|-----------------|
| **2** | Navigation | Deterministic | None | $0 | Structural flow: stuck, loops, dead ends |
| **3** | Per-Node Behavior | LLM (per node) | GPT-4.1-mini | ~$0.03/node | Instruction adherence, off-topic, hallucination |
| **4** | Overall Quality | LLM (one call) | GPT-4.1 | ~$0.15–0.30 | Holistic quality judgment from full transcript |

### Two Output Dimensions

| Dimension | Source | What it Measures | Dashboard Role |
|-----------|--------|-----------------|----------------|
| **Quality Score** | Layer 4 `quality_score` / 10 | Did the agent serve the user well? | Primary metric — drives dashboard, pass/fail |
| **Compliance Score** | Layer 3 avg `instructionAdherence.score` / 10 | Did the agent follow the script literally? | Secondary — shown separately for coaching |

Quality and compliance are **independent**. An agent can score Quality 9/10 (great service) but Compliance 3/10 (deviated from script). The dashboard displays quality as the primary metric.

---

### Layer 2: Node Navigation (Deterministic)

**Function:** `evaluateNavigation()` in `layeredEvaluator.ts`
**Input:** `NodeVisit[]` array + total node count + user utterance count
**Cost:** $0 (no LLM)
**Score:** 0–10

Checks for structural problems in the call flow:

| Check | Severity | Detection Logic |
|-------|----------|----------------|
| **Stuck** | Critical (−2) | Agent repeats itself 3+ times over 6+ turns |
| **Stuck (mild)** | Warning (−1) | 7–10 turns without progress (excludes piecemeal user input) |
| **Loop** | Critical/Warning | Same node visited >3 times (critical) or 3 times (warning) |
| **Backward jump** | Warning | Node revisited after leaving |
| **Dead end** | Warning | Call ends on non-end_call node without designated exit |

**Scoring:** Start at 10, deduct 2 per critical, 1 per warning. Minimum 0.

**Special handling:** Accounts for user-caused delays (short turns like "yes", digits, corrections) to avoid false stuck detection.

---

### Layer 3: Per-Node Behavior (LLM)

**Function:** `evaluateNodeBehavior()` in `layeredEvaluator.ts`
**Input:** One `NodeVisit` at a time + agent summary + preceding turns for context
**Model:** GPT-4.1-mini (default) or GPT-4.1 (for gender detection)
**Cost:** ~$0.01–0.05 per node (typical call: 3–8 nodes = $0.05–0.30)
**Score:** 0–10 per node

**What each node evaluation checks:**

For **conversation/start nodes:**
- **Instruction adherence** — Did the agent follow its node prompt? Returns `followed[]`, `violated[]`, `evidence`
- **Transition correctness** — Was the next-node transition allowed and appropriate?
- **Off-topic detection** — Did the user raise out-of-scope topics?
- **Hallucination** — Did the agent state info not in its instructions or extracted data?
- **Stuck detection** — Could the transition have happened earlier?

For **tool nodes:**
- Parameter extraction correctness
- Tool success/failure
- Post-tool transition correctness

**Per-node output:**
```json
{
  "instruction_adherence": { "score": 0-10, "followed": [], "violated": [], "evidence": "..." },
  "transition_correctness": { "score": 0-10, "correct": true, "reasoning": "..." },
  "off_topic": { "detected": false, "turns": [], "topics": [] },
  "hallucination": { "detected": false, "evidence": "" },
  "stuck": { "detected": false, "unnecessary_turns": 0 },
  "context_summary": "2-3 sentences about what happened at this node",
  "overall_node_score": 8
}
```

**Adaptive behavior rule:** If a per-node analysis flags "did not ask the required question" but the user had ALREADY stated their intent before the agent could ask — that is adaptive behavior, not a violation. Scored HIGH (9–10).

---

### Node Mapping: `mapNodeVisits()`

Before Layer 2 and 3 can run, transcript turns must be assigned to nodes. The `mapNodeVisits()` function handles this with a multi-strategy approach:

**Algorithm (two passes):**

1. **Pass 1 — Segment extraction:** Scan call log for `node_movement` boundaries → group events into segments
2. **Pass 2 — Node identification:** For each segment, identify the node using (in priority order):
   - **TRANSITION event's `next_node`** — highest confidence
   - **First segment = start node**
   - **Exact message text match** — node prompt vs. "Playing message" event text
   - **Graph traversal** — follow edges from previous matched node
   - **Fuzzy text match** — 60% word overlap after variable substitution

3. **Turn assignment:** Map transcript turns to segments by timestamp ordering. Remaining turns assigned to last conversation segment.

**Output:** Array of `NodeVisit` objects containing:
- Node identity (id, label, type, instructions)
- Allowed transitions + transition actually taken
- Transcript turns at this node only
- Variables extracted, tools called, tool results
- Timing (duration, entry/exit timestamps)

---

### Layer 4: Overall Quality (LLM — GPT-4.1)

**Function:** `evaluateOverall()` in `layeredEvaluator.ts`
**Model:** GPT-4.1 (explicit override)
**Cost:** ~$0.15–0.30 per call
**Score:** 0–10 (quality, NOT compliance)

**What Layer 4 receives (full context):**

| Data | Source | Truncation Limit |
|------|--------|-----------------|
| Full conversation transcript | Raw `transcript[]` | 20,000 chars |
| Tool execution results | `NodeVisit.toolResults[]` | 3,000 chars total, 500 per tool |
| System-recorded outcome | `run.outcomeResult` (objective_met, booked details, etc.) | No limit |
| Agent context | `agentSummary` | 2,000 chars |
| Call metadata | callOutcome, callDuration | — |
| Navigation analysis | Layer 2 issues | — |
| Per-node compliance | Layer 3 summaries (labeled "for reference only") | 2,000 chars |
| Eval context | User-defined project guidance | 2,000 chars |

**Scoring rules:**
- **HIGH (7–10):** Objective achieved, user served well, smooth interaction, correct escalations
- **MEDIUM (5–6):** Partial success, some issues but user mostly served
- **LOW (1–4):** Only for genuine agent failures (hallucination, stuck, wrong info, ignored user)
- **Ground truth:** If `outcomeResult` shows `objective_met = "yes"`, the call SUCCEEDED — quality_score must reflect this (7–10)
- **Compliance is separate:** Low compliance scores are explicitly labeled "for reference only — do NOT mirror into quality_score"

**Special handling:**
- Short calls (≤4 user turns): Caller likely hung up. `objective_achieved` = null (not applicable) rather than false
- Dead-end vs. hang-up: If agent's last message was actively serving, that's a caller hang-up, not agent failure
- Adaptive behavior: Skipping already-answered questions = good service, not a failure

**Output:**
```json
{
  "quality_score": 8,
  "objective_achieved": true,
  "caller_sentiment": "positive",
  "out_of_scope_handled": null,
  "out_of_scope_topics": [],
  "efficiency": { "score": 7, "reasoning": "Call was slightly longer than needed due to piecemeal data entry" },
  "critical_issues": [],
  "comments": ["Agent used equivalent phrasing instead of exact script at greeting node"],
  "improvements": ["Consider confirming the appointment time before ending the call"],
  "summary": "The agent successfully booked the appointment. The caller provided data slowly but the agent handled it well."
}
```

---

### Layered Evaluation Data Flow

```
runLayeredEvaluation(callLog, transcript, agentStructure, ...)
  │
  ├─ mapNodeVisits(callLog, transcript, nodes, edges)
  │   → NodeVisit[] (deterministic, $0)
  │
  ├─ evaluateNavigation(visits, totalNodes, userUtteranceCount)
  │   → Layer2Result: score/10, issues[] (deterministic, $0)
  │
  ├─ for each evaluable node:
  │     evaluateNodeBehavior(visit, agentSummary, precedingTurns, ...)
  │     → Layer3NodeResult per node (GPT-4.1-mini, ~$0.03/node)
  │
  └─ evaluateOverall(layer2, layer3, agentSummary, ..., outcomeResult, transcript, visits)
      → Layer4Result: quality_score/10, objective, sentiment, ... (GPT-4.1, ~$0.20)

Final output:
  qualityScore = layer4.overallScore / 10    → 0–100%
  complianceScore = avg(layer3[].instructionAdherence.score) / 10  → 0–100% or null
```

---

## Other Evaluation Criteria

Beyond `LAYERED_EVALUATION`, the platform supports additional criterion types, each routed by `CriterionType`:

### Deterministic Criteria (No LLM, $0)

| Type | What it Checks | Scoring |
|------|---------------|---------|
| **DETERMINISTIC** | Required tool calls + variable extraction in call log | `(found / required)` → 0–1.0 |
| **STRUCTURAL** | Node sequence traversal count vs. expected | `min(actual / expected, 1.0)` |
| **WORD_ACCURACY** | Human-annotated word errors (WER) | `1.0 − (errors / totalWords)` |
| **LATENCY** | Tool execution time + node transition time vs. thresholds | `(withinLimit / total)` |

### LLM Criteria

| Type | Model | Cost | What it Checks |
|------|-------|------|---------------|
| **LLM_JUDGE** | GPT-4.1-mini (GPT-4.1 for gender) | $0.002–0.008 | Rule-based transcript evaluation (gender forms, language switching, custom rules) |
| **FLOW_PROGRESSION** | GPT-4.1 | $0.05–0.15 | 8-category success metrics: language, gender, tool calls, data reading, node transitions, KB, MCP, outcome |
| **ACTION_CONSISTENCY** | GPT-4.1 | $0.10–0.20 | Cross-reference agent speech vs. system logs. Detects: hallucination, misread, tool failure, wrong transition, stuck |
| **ACTION_HALLUCINATION** | GPT-4.1 | $0.05–0.10 | Verify action claims ("I've booked your appointment") against tool logs + outcome variables |

### LLM_JUDGE Special Handling

**Gender detection:** Arabic morphology is nuanced — the agent is female by design. The criterion only evaluates whether the agent uses correct gender forms when addressing the CUSTOMER (not when referring to herself). Uses GPT-4.1 (not mini) for accuracy.

**Language switching:** Only two failure scenarios: (1) user asked to switch but agent didn't, (2) agent switched back without being asked. Everything else passes.

### ACTION_CONSISTENCY Root Causes

When errors are found, they're classified by root cause:

| Root Cause | Description |
|------------|-------------|
| `LLM_HALLUCINATION` | Agent generated info not in tool response |
| `LLM_MISREAD` | Agent read response but extracted wrong values |
| `TOOL_FAILURE` | Tool/API failed, agent didn't handle gracefully |
| `TOOL_NOT_CALLED` | Agent should have called tool but didn't |
| `WRONG_TOOL` | Called the wrong tool |
| `WRONG_TRANSITION` | Flow moved to incorrect node |
| `STUCK_TRANSITION` | Flow should have advanced but didn't |
| `ASR_ERROR` | Speech recognition misheard the user |
| `PROMPT_ISSUE` | Node prompt is ambiguous/incomplete |
| `MISSING_ERROR_HANDLING` | No fallback for failure scenario |

---

## Cost Summary

### Per-Call Evaluation Costs

| Component | Model | Typical Cost |
|-----------|-------|-------------|
| Layer 2 (Navigation) | None | $0.00 |
| Layer 3 (Per-Node) × 5 nodes | GPT-4.1-mini | $0.15 |
| Layer 4 (Overall Quality) | GPT-4.1 | $0.20 |
| **LAYERED_EVALUATION total** | — | **$0.30–0.70** |
| FLOW_PROGRESSION | GPT-4.1 | $0.05–0.15 |
| ACTION_CONSISTENCY | GPT-4.1 | $0.10–0.20 |
| ACTION_HALLUCINATION | GPT-4.1 | $0.05–0.10 |
| LLM_JUDGE (simple) | GPT-4.1-mini | $0.002–0.008 |
| Deterministic criteria | None | $0.00 |
| **Typical full evaluation** | — | **$0.40–0.80** |

### Model Pricing

| Model | Input | Output |
|-------|-------|--------|
| GPT-4.1 | $2.00 / M tokens | $8.00 / M tokens |
| GPT-4.1-mini | $0.40 / M tokens | $1.60 / M tokens |

### Project-Level Costs

| Operation | Model | Cost |
|-----------|-------|------|
| Agent summary generation | GPT-4.1 | ~$0.05 (one-time) |
| Project analysis (3–100 runs) | GPT-4.1 | $0.20–0.50 |
| Analysis comparison | GPT-4.1 | $0.10–0.20 |
| Prompt audit | GPT-4.1 | $0.10–0.30 |

### Cost Tracking

- **Per run:** Stored in `Run.evalCost` (cumulative across re-evaluations)
- **Per analysis:** Stored in `ProjectAnalysis.analysisCost`
- **Calculation:** Extracted from OpenAI API response `usage` fields (`prompt_tokens`, `completion_tokens`)
- **Temperature:** 0 for all evaluation calls (deterministic, reproducible)

---

## Backend: Routes & Services

### API Routes

#### Authentication — `routes/auth.ts`

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/auth/login` | Authenticate user, return JWT. Rate-limited: 10 attempts/15min per IP |
| POST | `/api/auth/register` | Create new user (requires auth). Inherits creator's organization |
| GET | `/api/auth/me` | Get authenticated user profile |

#### Projects — `routes/projects.ts`

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/projects` | List projects (user's own + org-mates + legacy) |
| POST | `/api/projects` | Create project (captures Hamsa agent structure + summary) |
| GET | `/api/projects/:id` | Get project with cursor-paginated runs (PAGE_SIZE=100) |
| PATCH | `/api/projects/:id` | Update project config |
| DELETE | `/api/projects/:id` | Delete project |
| GET | `/api/projects/:id/dashboard` | Dashboard analytics: KPIs, charts, issues, node performance |
| GET | `/api/projects/:id/runs-by-ids` | Fetch specific runs by ID array |
| POST | `/api/projects/:id/analyze` | Trigger LLM project analysis |
| POST | `/api/projects/:id/audit-prompts` | Audit agent node prompts |
| POST | `/api/projects/agent-preview` | Preview Hamsa agent before creating project |
| GET | `/api/projects/:id/full-export` | Stream full project bundle as JSON |
| POST | `/api/projects/import-bundle` | Import project bundle |
| GET | `/api/projects/:id/export-call-ids` | Export conversation IDs as CSV |

#### Runs — `routes/runs.ts`

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/runs/project/:projectId` | List runs (most recent 200) |
| GET | `/api/runs/:id` | Get run with full details |
| GET | `/api/runs/:id/recording-url` | Fetch fresh recording URL from Hamsa (CloudFront URLs expire) |
| POST | `/api/runs` | Create run stub |
| POST | `/api/runs/:id/evaluate` | Force re-evaluation |
| POST | `/api/runs/:id/rehydrate` | Re-fetch logs + transcript from Hamsa, re-evaluate |
| POST | `/api/runs/:id/fetch-logs` | Manually fetch call log |
| POST | `/api/runs/:id/switch-model` | Update agent LLM model via Hamsa API |
| PATCH | `/api/runs/:id` | Update run status/metadata |
| DELETE | `/api/runs/:id` | Delete run |
| POST | `/api/runs/compare` | Compare up to 20 runs |

#### History Import — `routes/history.ts`

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/history/:projectId/import` | Import by date range + period (auto-chunking on 500/504) |
| POST | `/api/history/:projectId/import-ids` | Import by conversation ID list |
| POST | `/api/history/:projectId/import-csv` | Async CSV export from Hamsa → import |
| GET | `/api/history/:projectId/status` | Import status aggregation |

#### Webhooks — `routes/webhooks.ts`

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/webhooks/hamsa/:projectId` | Project-specific webhook (HMAC-SHA256 verified) |
| POST | `/api/webhooks/hamsa` | Generic webhook (backward-compatible for LIVE projects) |

#### Labels — `routes/labels.ts`

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/labels/run/:runId` | Get word labels |
| POST | `/api/labels/run/:runId` | Create label |
| POST | `/api/labels/run/:runId/bulk` | Bulk create labels |
| DELETE | `/api/labels/:id` | Delete label |

#### Users — `routes/users.ts`

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/users` | List users (org-scoped) |
| POST | `/api/users` | Create user |
| PATCH | `/api/users/:id/password` | Reset password |
| DELETE | `/api/users/:id` | Delete user (cannot delete self) |

### Services

| Service | File | Purpose |
|---------|------|---------|
| **Evaluator** | `evaluator.ts` | Main evaluation orchestrator — routes criteria, computes scores |
| **Layered Evaluator** | `layeredEvaluator.ts` | 4-layer micro-evaluation (navigation → per-node → overall quality) |
| **LLM Judge** | `llmJudge.ts` | OpenAI interface — model selection, cost tracking, consistency guards |
| **Hamsa API** | `hamsaApi.ts` | Hamsa platform integration — agent CRUD, conversations, exports |
| **Project Analyzer** | `projectAnalyzer.ts` | LLM-powered pattern analysis across runs |
| **Reporting** | `reportingService.ts` | KPI reports + intelligence reports |
| **Run Search** | `runSearch.ts` | Full-text + filter-based run search |
| **Prompt Auditor** | `promptAuditor.ts` | LLM audit of agent node prompts for clarity |
| **Evaluation Runner** | `evaluationRunner.ts` | Queue orchestration + inline fallback |

---

## Frontend: Pages & Features

### Pages

| Route | Page | Description |
|-------|------|-------------|
| `/login` | Login | Email/password authentication |
| `/` | Projects | Project list with import/export |
| `/projects/new` | NewProject | Create project (WEBHOOK/HISTORY/LIVE) with agent preview |
| `/projects/:id` | ProjectDetail | Main hub: dashboard, run list, search, tabs |
| `/projects/:id/runs/:runId` | RunDetail | Full call evaluation: recording, transcript, criteria, workflow |
| `/projects/:id/analyses` | ProjectAnalyses | LLM analysis history with date filters |
| `/projects/:id/analyses/compare` | AnalysisCompare | Compare analysis versions over time |
| `/projects/:id/report` | ProjectReport | Weekly KPI trends, shareable |
| `/users` | Users | User management (create, password reset, delete) |

### Dashboard Features (ProjectDashboard)

**KPI Cards:**
- Total Runs, Quality (avg %), Compliance (avg %), Pass Rate (%)
- Objective Achieved rate, Avg Duration

**Charts:**
- Score trend (line chart, daily/hourly granularity)
- Call outcome distribution (donut)
- Intent distribution (pie, up to 20 intents)
- Sentiment distribution (pie)
- Score distribution (10-bucket bar chart)

**Filters (composable, all combinable):**
- Date range: presets (Today, Yesterday, 7d, 30d, 90d) + custom
- Outcome, Objective, Score range, Node, Issue, Criteria, Intent
- Trend period (click chart dot)
- Free-text search

**Table:**
- Columns: Conv ID, Date, Outcome, Score, Duration, extracted outcome fields
- Sorting, search, bulk select, bulk re-evaluate, CSV export
- Cursor-based pagination (100 per page, "Load More")

### Run Detail Features

**Call Recording:**
- HTML5 audio player with CloudFront URL auto-refresh on expiry
- Audio sync to workflow canvas (active node pulses during playback)

**Scores & Badges:**
- Quality Score (0–100%, color-coded)
- Compliance Score (0–100%, color-coded)
- Objective badge (Met / Not Met)
- Goal Assessment (SUCCESSFUL / PARTIAL / FAILED with reason)
- Eval cost display

**Analysis Sections:**
- Per-criterion results with expandable details
- Flow Progression metrics (8 categories)
- Action Consistency errors (by severity, root cause, with suggested fixes)
- Action Hallucination (hallucinated vs. verified actions)
- Layered Node Evaluation (per-node instruction adherence, stuck, off-topic)

**Transcript & Word Labeling:**
- Full transcript display (Agent/User alternating)
- Click any word → label modal (ASR_ERROR, LLM_ERROR, TTS_ERROR, WRONG_LANGUAGE, WRONG_GENDER, HALLUCINATED)
- Optional correction text

**Workflow Canvas:**
- ReactFlow graph visualization
- Node colors by type (start→green, conversation→indigo, tool→orange, router→purple, end→red)
- Visited nodes highlighted green, stuck nodes red
- Active node during playback: pulsing border, others dim to 40% opacity
- Tool calls + extracted variables annotated on nodes

**Actions:**
- Rehydrate & Re-evaluate (fetch fresh data from Hamsa)
- Re-evaluate (trigger eval, poll completion)
- Export JSON / Full Export

---

## Database Schema

### Core Models

| Model | Purpose | Key Fields |
|-------|---------|------------|
| **Organization** | Multi-tenant container | id, name |
| **User** | Account | email, passwordHash, organizationId |
| **Project** | Voice agent evaluation setup | type (LIVE/HISTORY/WEBHOOK), agentStructure, agentSummary, evalContext, hamsaApiKey |
| **Criterion** | Evaluation rule | type (enum), rule, weight, expectedValue |
| **Run** | Single call execution | status, callOutcome, callDuration, transcript, callLog, webhookData, outcomeResult, overallScore, evalCost |
| **EvalResult** | Criterion result | passed, score, detail (JSON string), metadata |
| **WordLabel** | Transcript annotation | wordIndex, labelType, correction |
| **ProjectAnalysis** | LLM analysis snapshot | version, runCount, analysis (JSON), analysisCost |
| **AuditLog** | Activity tracking | action, userId, resourceId, ip, requestId |

### Key Enums

- **ProjectType:** `LIVE` | `HISTORY` | `WEBHOOK`
- **RunStatus:** `PENDING` → `RUNNING` → `AWAITING_DATA` → `EVALUATING` → `COMPLETE` | `FAILED`
- **CriterionType:** `DETERMINISTIC` | `LLM_JUDGE` | `STRUCTURAL` | `WORD_ACCURACY` | `LATENCY` | `FLOW_PROGRESSION` | `ACTION_CONSISTENCY` | `ACTION_HALLUCINATION` | `LAYERED_EVALUATION`
- **LabelType:** `WRONG_WORD` | `WRONG_LANGUAGE` | `WRONG_GENDER` | `HALLUCINATED` | `LLM_ERROR` | `TTS_ERROR` | `ASR_ERROR`

---

## Authentication & Security

### JWT Authentication
- **Sign:** `signToken(userId, email, organizationId)` → 30-day expiry
- **Verify:** `requireAuth` middleware extracts userId, email, organizationId from token
- **Organization embedded in JWT:** Zero-cost org checks per request (no DB hit)

### Password Security
- Bcrypt hashing with configurable rounds
- Timing-attack prevention: dummy hash comparison on user-not-found
- Validation: min 8 chars, requires uppercase + number + special character

### Rate Limiting
- Login: 10 attempts / 15min per IP
- Evaluation endpoints: 60 / 10min
- LLM endpoints: 20 / 5min
- Webhooks: 300 / min

### Webhook Security
- HMAC-SHA256 signature verification (`X-Hamsa-Signature: sha256=<hex>`)
- Constant-time comparison (timing-attack safe)

### Access Control
- Legacy projects (userId=null): accessible to all
- Owner: userId match → full access
- Organization: same org membership → access

---

## External Integrations

### Hamsa Voice AI API

**Base URL:** `https://api.tryhamsa.com` (configurable via `HAMSA_API_BASE`)
**Auth:** `Authorization: Token {HAMSA_API_KEY}`

| Endpoint | Usage |
|----------|-------|
| `GET /v2/voice-agents/:agentId` | Fetch agent config (structure, workflow, preamble) |
| `PATCH /v2/voice-agents/:agentId` | Update agent LLM model or workflow nodes |
| `GET /v1/voice-agents/conversation/:id` | Fetch call transcript + logs + metadata |
| `GET /v1/agent-analytics/logs?jobId=` | Fetch execution logs (node events, tool calls) |
| `GET /v1/agent-analytics/conversations/export` | Excel export (with auto-chunking on 500/504) |
| `POST /v1/agent-analytics/conversations/export` | Async CSV export request |
| `GET /v1/agent-analytics/conversations/export/status` | Poll CSV export status |

### OpenAI API

**Models used:**
- `gpt-4.1` — Layer 4 quality judgment, complex Arabic analysis, action consistency, flow progression
- `gpt-4.1-mini` — Layer 3 per-node evaluation, simple criteria (LLM_JUDGE)

**Configuration:** Temperature 0, JSON response format enforced, cost tracked per call.

**Consistency guards:** If the LLM's JSON verdict contradicts its detail text, the system corrects based on the detail (the model sometimes reasons correctly but produces wrong JSON fields).

---

## Queue & Worker System

### BullMQ + Redis

**Queue name:** `evaluation`
**Fallback:** Inline execution if Redis unavailable

**Job types:**

| Job | Purpose | Retries | Backoff |
|-----|---------|---------|---------|
| `check-and-evaluate` | Evaluate run if callLog + transcript present | 3 | Exponential (5s) |
| `fetch-call-log` | Fetch execution logs from Hamsa API | 5 | Exponential (3s) |

**Worker:** Concurrency 2 jobs in parallel.

**Startup recovery:** Resets stuck `EVALUATING` runs back to `PENDING`.

**Concurrency safety:** All status transitions use `updateMany` with status guards (e.g., only transition PENDING → EVALUATING), ensuring safe operation across multiple processes.

### Health Check

`GET /api/health` returns:
- DB status: `SELECT 1` probe
- Queue status: Redis connection state
- Returns 503 if either fails (for load balancer health checks)
