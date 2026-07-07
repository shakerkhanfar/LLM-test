# Agent Scenario Testing & Stress-Test Harness — Implementation Plan

**Date:** 2026-07-07
**Status:** Plan. Prototype transport proven in `tools/chat-tester/` (separate rig); this plan folds it into the hamsa-eval dashboard.
**Goal:** Understand an agent's flow → auto-derive scenarios & edge cases → drive the agent over **chat** (scripted or LLM-simulated) → evaluate each conversation → surface findings tied to nodes → catch regressions across agent versions.

---

## 0. The core insight — reuse, don't rebuild

The `tools/chat-tester/` working notes describe building three hard things from scratch: an **analyzer**, an **automated node/tool-trace fetcher**, and an **agent-flow understanding layer**. **All three already exist in this repo and work.** The prototype hit them from a standalone Python/Playwright rig that couldn't reach them.

| Prototype "next step" | Already exists here |
| --- | --- |
| Automate node/tool trace fetch (§4 of notes; 431 in Python) | `hamsaApi.ts → fetchCallLog()` (`/v1/agent-analytics/logs?jobId=`) **works from Node**; `fetchConversation()` returns `conv.logs` (node/tool trace). Wired in `webhooks.ts → hydrateWebhookRun()`. |
| Analyzer stage (LLM reads transcript + trace, evaluates assertions, cross-checks spoken vs tool data) | `evaluator.ts` (per-run, dispatches criteria), `layeredEvaluator.ts`, `projectAnalyzer.ts` (aggregate → `critical_failures`, `missing_edge_cases`, node-mapped fixes). Criterion types already include `FLOW_PROGRESSION`, `ACTION_CONSISTENCY`, `ACTION_HALLUCINATION`, `LLM_JUDGE`, `LAYERED_EVALUATION`. |
| Understand agent flow / scenarios / success criteria | `getAgent()` → `agentStructure`; `extractFlowDefinition()` (nodes/adjacency/tool nodes/start); `generateAgentSummary()` (LLM: purpose, flow, success criteria); BFS→ordered stages in `projects.ts`. |
| In-browser SDK transport | `frontend/src/components/CallAgent.tsx` already drives the Hamsa SDK live, captures `jobId` on `callStarted`, streams transcript, then polls → `fetchLogs` → `triggerEvaluation` → COMPLETE. |

**Therefore a chat scenario test is just a `Run` with a new `source` that flows through the existing hydrate → `runEvaluationCheck` → `projectAnalyzer` pipeline.** The build reduces to four net-new pieces:

1. **Scenario layer** — a `Scenario` model + auto-generation from the flow graph.
2. **Chat driver** — a `CallAgent` variant using the SDK's chat-only mode (`isChatOnly: true` + `sendMessage()`), plus a headless variant for batch/CI.
3. **Simulated caller** — an LLM roleplaying the caller, reacting to the agent turn-by-turn.
4. **Batch runner + regression diff** — run a suite against an agent version, diff against a baseline.

Everything else is reuse.

---

## 1. What exists today (map)

**Backend (`backend/src/`)**
- `services/hamsaApi.ts` — `getAgent` (full flow graph), `fetchCallLog` (jobId → node/tool trace), `fetchConversation` (transcript + `logs` + agent snapshot), `updateAgentWorkflow` (PATCH nodes), `updateAgentModel`, transcript extractors.
- `routes/webhooks.ts` — canonical ingestion: create `Run` → `hydrateWebhookRun` (fetch logs, retry) → `runEvaluationCheck`. **This is the exact lifecycle a chat run will reuse.**
- `services/evaluationRunner.ts` — `runEvaluationCheck` (queue/inline, atomic claim, AI-eval gate), `runCallLogFetch`.
- `services/evaluator.ts` — `evaluateRun` dispatches per-criterion scoring; writes `EvalResult` + `overallScore`.
- `services/projectAnalyzer.ts` — `analyzeProject` aggregates runs → versioned structured analysis (`critical_failures`, `missing_edge_cases`, `prompt_issues`, node-mapped `suggested_fix`) + version comparison.
- `services/llmJudge.ts` — `generateAgentSummary` (agent → purpose/flow/success-criteria text).
- `routes/projects.ts` (3.2k lines) — onboarding (`POST /`: getAgent → agentStructure → `extractFlowDefinition` → `generateAgentSummary` → seed criteria), `refresh-agent`, criteria CRUD, `analyze`, `re-evaluate`, `rehydrate-runs`, `prompt-audit` (+ apply), funnels.
- `mcp/tools/_read/agentStructure.ts` — `get_agent_structure`, `get_node_prompt` (with secret redaction). `_write/applyNodePromptFix.ts` — surgical node-prompt patching via `updateAgentWorkflow`.
- Prisma models: `Project` (agentStructure, flowDefinition, agentSummary, intentionConfig, evalContext, criteria), `Run` (hamsaCallId, conversationId, `source`, transcript, callLog, outcomeResult, overallScore, evalResults), `Criterion`/`EvalResult`, `ProjectAnalysis` (versioned + comparison).

**Frontend (`frontend/src/`)** — React 19, react-router 7, `@xyflow/react`, recharts, `@hamsa-ai/voice-agents-sdk@0.5.7`.
- `components/CallAgent.tsx` — in-browser SDK driver (template for the chat driver).
- `components/WorkflowCanvas.tsx` — renders the flow graph (xyflow).
- `pages/ProjectDetail.tsx` — tabbed project view (where a **Testing** tab slots in).
- `pages/ProjectAnalyses.tsx` / `Compare.tsx` / `ReportCompare.tsx` — analysis + comparison UI (template for regression diff).
- `api/client.ts` — `updateRun`, `fetchLogs`, `triggerEvaluation`, `getRun`.

---

## 2. Target architecture & data flow

```
                    ┌─────────────────────────────────────────────┐
                    │  Agent understanding (EXISTS)                │
   agentStructure ─▶│  extractFlowDefinition · generateAgentSummary│
                    └───────────────┬─────────────────────────────┘
                                    │ flow graph + summary
                                    ▼
                    ┌─────────────────────────────────────────────┐
   NEW              │  Scenario Generator (LLM)                    │
                    │  → Scenario[] (happy / edge / adversarial),  │
                    │    each tagged with target nodeIds+assertions│
                    └───────────────┬─────────────────────────────┘
                                    │ Scenario
                                    ▼
   NEW  ┌──────────────────┐   drives    ┌──────────────────────────┐
        │  Chat Driver     │────────────▶│ Hamsa SDK  isChatOnly:true│──▶ agent flow + tools
        │  (browser + node)│◀────────────│ chatMessageReceived, jobId│
        └────────┬─────────┘  transcript └──────────────────────────┘
                 │ + caller turns (scripted | simulated LLM = NEW)
                 ▼
        Run{ source: CHAT_TEST, scenarioId, testBatchId, hamsaCallId }   (NEW columns)
                 │
                 ▼  hydrate + evaluate  (EXISTS, unchanged)
        fetchConversation/fetchCallLog → runEvaluationCheck → EvalResult[] + overallScore
                 │                                    ▲
                 │                          + SCENARIO_ASSERTIONS criterion (NEW)
                 ▼
        TestBatch results  ──▶  projectAnalyzer (EXISTS)  ──▶ findings tied to nodeId
                 │
                 ▼  NEW
        Regression diff (baseline TestBatch ↔ candidate)  ·  Fix loop via applyNodePromptFix (EXISTS)
```

**One-line summary:** derive scenarios from the flow graph → drive chat → the resulting `Run` reuses the whole existing evaluate/analyze/fix stack.

---

## 3. Data model changes (Prisma)

Additive only — no changes to existing eval flow.

```prisma
enum RunSource { LIVE  HISTORY  WEBHOOK  CHAT_TEST }   // + CHAT_TEST

model Run {
  // ... existing ...
  scenarioId   String?     // set for CHAT_TEST runs
  scenario     Scenario?   @relation(fields: [scenarioId], references: [id])
  testBatchId  String?     // groups runs from one batch execution
  testBatch    TestBatch?  @relation(fields: [testBatchId], references: [id])
  @@index([testBatchId])
  @@index([scenarioId])
}

enum ScenarioMode     { SCRIPTED  SIMULATED }
enum ScenarioCategory { HAPPY_PATH  EDGE_CASE  ADVERSARIAL  IDENTITY  NO_SLOTS  TASK_SWITCH  OUT_OF_SCOPE  CANCEL_RESCHEDULE  CUSTOM }

model Scenario {
  id            String            @id @default(cuid())
  projectId     String
  project       Project           @relation(fields: [projectId], references: [id], onDelete: Cascade)
  name          String
  category      ScenarioCategory  @default(CUSTOM)
  mode          ScenarioMode      @default(SIMULATED)
  persona       String?           // simulated: caller roleplay brief
  goal          String?           // what the caller wants
  facts         Json?             // info revealed only when asked (name, mobile, MRN…)
  turns         Json?             // scripted: exact caller lines in order
  assertions    Json?             // per-scenario checks the analyzer evaluates
  targetNodeIds String[]          // flow nodes this scenario is meant to exercise
  maxTurns      Int               @default(14)
  timeouts      Json?             // { greeting_s, reply_s, quiet_ms }
  safeMode      Boolean           @default(false) // real-HIS: decline final booking
  autoGenerated Boolean           @default(false)
  enabled       Boolean           @default(true)
  runs          Run[]
  createdAt     DateTime          @default(now())
  updatedAt     DateTime          @updatedAt
  @@index([projectId])
}

model TestBatch {
  id            String    @id @default(cuid())
  projectId     String
  project       Project   @relation(fields: [projectId], references: [id], onDelete: Cascade)
  label         String
  status        String    @default("RUNNING")  // RUNNING | COMPLETE | FAILED
  isBaseline    Boolean   @default(false)
  agentSnapshot Json?     // agentStructure hash/snapshot at run time (for regression provenance)
  summary       Json?     // pass/fail counts, avg score, findings rollup
  runs          Run[]
  createdAt     DateTime  @default(now())
  @@index([projectId])
}
```

New criterion type for assertion scoring:

```prisma
enum CriterionType { /* ...existing... */  SCENARIO_ASSERTIONS }
```

`SCENARIO_ASSERTIONS` is an LLM-judge variant that reads the run's `scenario.assertions` + transcript + `callLog` and returns per-assertion pass/fail with evidence. It slots into `evaluator.ts`'s existing dispatch exactly like `LLM_JUDGE`.

---

## 4. Component 1 — Scenario generation (understand the agent → derive scenarios)

**Input:** `project.flowDefinition` (nodes/adjacency/tool nodes/start), `project.agentStructure` (node prompts, transitions, extracted variables, tools), `project.agentSummary`.

**Method:** a new `services/scenarioGenerator.ts` with an LLM pass (reuse the OpenAI client + JSON-mode pattern from `projectAnalyzer.ts`). Feed it the same compact flow representation `generateAgentSummary` already builds, plus explicit edge/transition conditions, and ask for a scenario matrix. Deterministic scaffolding around the LLM:

- **Path enumeration (deterministic):** BFS/DFS over `flowDefinition.adjacency` from `startNodeId` to terminal nodes → happy-path spine + each branch. Every branch condition (`node.transitions[*].condition`) becomes a candidate scenario ("caller triggers this transition").
- **Edge-case seeds (rule-based, from known repo gotchas):** for each node type, emit standard stressors:
  - Identity/confirm nodes → mismatch + "no/unclear" answer (the **Bug A** repro — Confirm-Identity loop).
  - Tool/async nodes → slow/empty/error tool return (the **Bug B** class — "promises slots, never presents").
  - Slot/router nodes → no-slots-available, ambiguous choice, menu/out-of-range input.
  - Any node → mid-flow task switch, barge-in/repeat, out-of-scope, silence/timeout.
  - Variable-extraction nodes → malformed input (wrong-format mobile, non-numeric age).
- **LLM enrichment:** for each seed, the LLM writes `persona`, `goal`, `facts` (grounded in the node's extracted variables), `assertions` (what "correct" looks like), and tags `targetNodeIds`.

**Output:** `Scenario[]` persisted as `autoGenerated: true`, grouped by `category`, editable in the UI. Re-runnable on `refresh-agent` (flow changed → regenerate/diff scenarios).

**Assertions are the contract.** Each scenario carries free-text assertions that the `SCENARIO_ASSERTIONS` criterion evaluates against transcript + trace, e.g.:
- "Agent presents at least one concrete slot (day + time) before Confirm Booking." (Bug B)
- "On identity 'no', agent re-asks for mobile or escalates within 2 turns — never loops the same question." (Bug A)
- "No spoken appointment ID / MRN read digit-by-digit." "Dates use the current year." "No booking claimed unless a tool write in `callLog` confirms it." (cross-checks the known false-positive classes.)

---

## 5. Component 2 — Chat driver

**SDK bump:** `frontend` and any headless runner move `@hamsa-ai/voice-agents-sdk` `0.5.7 → 0.6.1` (additive, no breaking changes) for `isChatOnly`, `sendMessage`, `chatMessageReceived`.

**Shared core (`chatSession` util):** wraps the SDK — `start({ agentId, params, isChatOnly: true })`, capture `jobId` from `callStarted`, collect **final** `chatMessageReceived` messages in order, end-of-agent-turn via the quiet-period heuristic (≥1 new final agent bubble, then `quiet_ms`), `sendMessage(text)`, `end()`. Ported from the prototype's `driver.html`, minus the Playwright scaffolding.

**Two execution surfaces:**
- **Interactive (in-dashboard):** a `ChatTester.tsx` component — a near-clone of `CallAgent.tsx` with `voiceEnablement:true` → `isChatOnly:true`, mic UI → a text box + "run simulated" button. Reuses the identical post-call pipeline `CallAgent` already has (`updateRun` → poll → `fetchLogs` → `triggerEvaluation` → poll COMPLETE). Lets a human watch/steer a single scenario live.
- **Batch/CI (headless):** keep the prototype's Playwright + `driver.html` rig for `TestBatch` execution (runs N scenarios without a human tab open). Same `chatSession` core loaded via the SDK UMD build; each conversation POSTs a `Run{source: CHAT_TEST}` and lets the backend hydrate+evaluate. This is the only place a browser is unavoidable (SDK is browser/WebRTC-first).

**Run creation:** the driver creates the `Run` up front (`source: CHAT_TEST`, `scenarioId`, `testBatchId`, `modelUsed`), then sets `hamsaCallId` on `callStarted`. Post-conversation, the **existing** `hydrateWebhookRun`-equivalent path fetches `conv.logs` and calls `runEvaluationCheck`. No new evaluation code.

---

## 6. Component 3 — Simulated caller

An LLM roleplays the caller from `persona` / `goal` / `facts`, one turn per agent turn, emitting `[END]` when the goal is met or the agent is irrecoverably stuck (capped at `maxTurns`).

**Recommendation:** run simulation **server-side using the backend's existing OpenAI client** (not `claude -p` subprocess as in the prototype). Rationale: (a) consistent with the rest of the codebase (`openai` SDK everywhere), (b) no per-turn subprocess spawn → batch-friendly, (c) keys already configured. The headless browser only handles SDK transport; each caller turn is an API call the runner makes. Scripted mode needs no LLM.

**Safety in the simulator prompt:** for `safeMode` scenarios (real HIS — Mouwasat, Al Salama), the persona is instructed to **decline final booking confirmation** so no real appointment is written. Only mock/n8n backends (e.g. the HMG n8n-tools agent) or approved test MRNs get exercised end-to-end. This rule is enforced in the simulator system prompt and surfaced as a scenario badge in the UI.

---

## 7. Component 4 — Analyzer (mostly reuse)

- **Per-run:** existing `evaluateRun` runs the project's criteria (FLOW_PROGRESSION catches stuck nodes/failed transitions; ACTION_CONSISTENCY/HALLUCINATION cross-check spoken vs tool data) **plus** the new `SCENARIO_ASSERTIONS` criterion scoring the scenario's assertions. Output: `EvalResult[]` + `overallScore` per scenario run, exactly like a live call.
- **Per-batch:** feed the batch's runs into `projectAnalyzer.analyzeProject` (scoped by `testBatchId` — add a `runIds`/`testBatchId` filter to `AnalysisFilter`). Output: the existing versioned structured findings (`critical_failures`, `missing_edge_cases`, node-mapped `suggested_fix`), now sourced from *designed* stress tests instead of whatever live calls happened to arrive.
- **Findings are already node-anchored** — `projectAnalyzer` references node labels/prompt locations and emits exact-text fixes. This directly matches the "each finding tied to a node id + suggested fix" requirement.

**Known false-positive guardrails (from memory):** the `ACTION_HALLUCINATION` "Not Met" false positives (WEBHOOK runs where tool-log writes aren't captured) apply here too — chat runs must verify against `outcomeResult.appointment_id` / a confirmed `callLog` tool write before asserting "booking not written." Encode this in the `SCENARIO_ASSERTIONS` prompt and reuse whatever fix lands for the live path.

---

## 8. Component 5 — Batch runner + regression diff

- **Batch runner:** `POST /projects/:id/test-batches` — takes a scenario set (or "all enabled"), creates a `TestBatch`, executes each scenario via the headless driver (bounded concurrency, like the inline eval sweep's `CONCURRENCY=3`), waits for all runs COMPLETE, writes `summary` (pass/fail counts, avg score, top findings).
- **Baseline:** mark a batch `isBaseline`. Store `agentSnapshot` for provenance.
- **Regression diff:** `POST /projects/:id/test-batches/compare` (baseline ↔ candidate). Per scenario: pass→fail (regression), fail→pass (fix), score delta, new/resolved findings. Reuse the diff/writeup pattern from `reportComparison.ts` / `compareAnalyses`. UI mirrors `ReportCompare.tsx`.
- **This is the payoff:** a prompt/graph edit that fixes Bug A but breaks slot presentation is caught because both scenarios run every batch.

---

## 9. Component 6 — Fix loop (reuse)

Findings already carry node-anchored `suggested_fix`. The MCP write tool `applyNodePromptFix` (→ `updateAgentWorkflow`) and the `prompt-audit/apply` endpoint already patch node prompts. Loop: run batch → findings → apply fix (human-approved) → refresh-agent (regenerate scenarios if flow changed) → re-run batch → regression diff. No new fix machinery.

---

## 10. UI/UX (dashboard)

New **Testing** tab in `ProjectDetail.tsx`:
1. **Scenarios** — auto-generated + custom scenarios, grouped by category, editable (persona/goal/facts/assertions/turns), enable/disable, `safeMode` badge, "Regenerate from flow" button. Overlay coverage onto `WorkflowCanvas` (which nodes are exercised — highlight untested nodes).
2. **Run** — pick scenario(s) → interactive `ChatTester` (watch live) or "Run batch" (headless). Live transcript + agent-state indicator (reuse `CallAgent` visuals).
3. **Results** — per-scenario pass/fail, score, assertion breakdown, findings with node links; batch rollup.
4. **Regression** — baseline picker + diff view (regressions in red, fixes in green, score deltas), reusing compare UI.

---

## 11. Phased roadmap

| Phase | Deliverable | Key tasks | Touchpoints |
| --- | --- | --- | --- |
| **P0 — Spike (1–2 d)** | One scenario drives HMG n8n agent over chat in-dashboard, produces an evaluated `Run`. | Bump SDK→0.6.1; clone `CallAgent`→`ChatTester` with `isChatOnly`+`sendMessage`; add `RunSource.CHAT_TEST`; reuse existing hydrate/eval. | `frontend` SDK, `ChatTester.tsx`, `schema.prisma` |
| **P1 — Scenario layer (3–4 d)** | Persisted scenarios + auto-generation from flow graph; scripted + simulated modes. | `Scenario`/`TestBatch` models; `scenarioGenerator.ts`; server-side simulated caller; scenario CRUD routes + Testing tab (Scenarios + Run). | `schema.prisma`, `services/scenarioGenerator.ts`, `routes/projects.ts` or new `routes/testing.ts`, frontend |
| **P2 — Analyzer + assertions (2–3 d)** | Per-scenario assertion scoring + batch-scoped analysis with node-anchored findings. | `SCENARIO_ASSERTIONS` criterion in `evaluator.ts`; `analyzeProject` batch filter; Results UI. | `services/evaluator.ts`, `services/projectAnalyzer.ts`, frontend |
| **P3 — Batch + regression (3–4 d)** | Headless batch runner, baselines, regression diff. | Playwright runner over `chatSession` core; batch endpoints; diff endpoint + UI (reuse `reportComparison`). | `tools/chat-tester/` (headless), `routes/testing.ts`, frontend |
| **P4 — Fix loop + CI (2–3 d)** | One-click apply fix + re-run; scheduled/CI batch with regression gate. | Wire `applyNodePromptFix`/`prompt-audit/apply`; optional cron batch; alert on new regressions. | existing MCP/write, scheduler |

Reproduce the two known bugs (Bug A identity loop, Bug B slot stall) as first-class scenarios in **P1** — they are the acceptance test for the whole harness.

---

## 12. Open decisions (recommend, but confirm)

1. **Simulated caller engine** — recommend backend OpenAI (consistency + batch-friendly) over `claude -p`. *Alternative:* keep `claude -p` for exploratory bug-hunting only.
2. **Batch transport** — recommend keeping the headless Playwright rig for batch (SDK is browser-only). *Alternative:* investigate a Node WebRTC shim to avoid a browser (higher risk, reimplements token/init handshake).
3. **Scenario storage vs. YAML** — recommend DB-backed `Scenario` (editable in-app, versioned with the project). *Alternative:* keep YAML files (portable, git-diffable) with an importer. Could support both (YAML import → DB).
4. **Assertion scoring** — recommend a dedicated `SCENARIO_ASSERTIONS` criterion. *Alternative:* inject assertions into the existing `LLM_JUDGE` `expectedValue` per run.

---

## 13. Risks & mitigations

- **Chat ≠ voice fidelity** — chat exercises the same flow graph + tools but skips ASR/TTS/barge-in. Keep `CallAgent` (voice) for audio-layer regressions; chat covers logic/flow/tools. State this scope explicitly in the UI.
- **Turn-completion heuristic** — agents emit multiple bubbles/turn; slow tools can cut a turn early. Tune `quiet_ms` per agent (already a scenario `timeouts` field).
- **Cost** — simulated caller = 1 LLM call/turn + eval cost/run. Prefer scripted for regression suites; simulated for exploration. Bound batch concurrency.
- **Safety on real HIS** — `safeMode` + persona-declines-confirmation; default new real-backend agents to `safeMode: true`. Never write real appointments.
- **Flow drift** — regenerate scenarios on `refresh-agent`; diff scenario set so new/removed nodes surface as coverage gaps.

---

## 14. Success criteria

- Bug A and Bug B reproduce deterministically as saved scenarios and show up as node-anchored findings.
- A prompt fix that resolves one and breaks another is caught by the regression diff.
- Auto-generated scenarios cover ≥90% of reachable flow nodes (coverage overlay on `WorkflowCanvas`).
- End-to-end (scenario → chat → evaluated Run → finding) runs entirely inside the dashboard with no manual log export.
