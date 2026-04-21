import prisma from "../lib/prisma";
import OpenAI from "openai";
import dotenv from "dotenv";
dotenv.config();

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Cost per million tokens for gpt-4.1
const GPT41_INPUT  = 2.00;
const GPT41_OUTPUT = 8.00;

function calcCost(promptTokens: number, completionTokens: number): number {
  return (promptTokens / 1_000_000) * GPT41_INPUT
       + (completionTokens / 1_000_000) * GPT41_OUTPUT;
}

// Mirrors the frontend computeGoal logic so backend and frontend agree on status
function computeGoalStatus(run: any): "SUCCESSFUL" | "FAILED" | "PARTIAL" | null {
  if (run.status !== "COMPLETE") return null;
  const callStatus = (run.callStatus || "").toUpperCase();
  const outcome    = (run.callOutcome || "").toLowerCase();
  const score: number | null = run.overallScore ?? null;

  if (["NO_ANSWER", "BUSY", "VOICEMAIL"].includes(callStatus)) return "FAILED";
  if (callStatus === "FAILED") return "FAILED";

  const isNegative = outcome.includes("not_interested") || outcome.includes("rejected")
                  || outcome.includes("refused")        || outcome.includes("declined");
  const isPositive = !isNegative && (
    outcome.includes("interested") || outcome.includes("success")   ||
    outcome.includes("booked")     || outcome.includes("converted") ||
    outcome.includes("completed")  || outcome.includes("agreed")
  );
  const isFollowup = outcome.includes("followup") || outcome.includes("callback")
                  || outcome.includes("pending")   || outcome.includes("later");

  if (isNegative) return (score != null && score >= 0.7) ? "PARTIAL" : "FAILED";
  if (isPositive) return (score == null || score >= 0.7) ? "SUCCESSFUL" : "PARTIAL";
  if (isFollowup) return "PARTIAL";
  if (score == null) return null;
  if (score >= 0.8) return "SUCCESSFUL";
  if (score >= 0.5) return "PARTIAL";
  return "FAILED";
}

export interface AnalysisFilter {
  /** Which date dimension to filter on. Omit to include all complete runs. */
  dateFilterType?: "CALL_DATE" | "EVAL_DATE";
  from?: string; // YYYY-MM-DD
  to?: string;   // YYYY-MM-DD
}

// ── Multi-version comparison ────────────────────────────────────────────────

export async function compareAnalyses(projectId: string, analysisIds: string[]) {
  // Fetch requested analyses — ownership check via projectId in the where clause
  const analyses = await prisma.projectAnalysis.findMany({
    where: { id: { in: analysisIds }, projectId },
    orderBy: { version: "asc" },
  });

  if (analyses.length < 2) {
    throw new Error(
      `At least 2 matching analyses are required (found ${analyses.length})`
    );
  }

  // Build compact per-version summaries — same field extraction used for
  // auto-comparison to avoid raw JSON slicing.
  // Cap field lengths to keep the prompt bounded even with 6 versions.
  // Long free-text fields are trimmed; list fields are capped at 5 items.
  function trimStr(s: unknown, max: number): string {
    if (typeof s !== "string") return "";
    return s.length > max ? s.slice(0, max) + "…" : s;
  }

  const summaries = analyses.map((av) => {
    const a = av.analysis as any;
    return {
      version:           av.version,
      runsIncluded:      av.runsIncluded,
      healthScore:       av.healthScore,
      overall_health:    a.overall_health,
      // Include only date portion of createdAt for prompt clarity
      createdAt:         new Date(av.createdAt).toISOString().split("T")[0],
      executive_summary: trimStr(a.executive_summary, 300),
      priority_actions:  (a.priority_actions ?? []).slice(0, 5),
      critical_failures: (a.critical_failures ?? []).slice(0, 5).map((f: any) => ({
        area:       trimStr(f.area, 80),
        frequency:  f.frequency,
        root_cause: trimStr(f.root_cause, 120),
        detail:     trimStr(f.detail, 150),
      })),
      missing_edge_cases: (a.missing_edge_cases ?? []).slice(0, 4).map((e: any) => ({
        scenario:  trimStr(e.scenario, 80),
        frequency: e.frequency,
      })),
      prompt_issues: (a.prompt_issues ?? []).slice(0, 4).map((p: any) => ({
        location: trimStr(p.location, 60),
        issue:    trimStr(p.issue, 120),
      })),
      best_parts: (a.best_parts ?? []).slice(0, 3).map((b: any) => ({
        area:   trimStr(b.area, 80),
        detail: trimStr(b.detail, 120),
      })),
    };
  });

  const versionLine = summaries
    .map((s) =>
      `v${s.version} (${s.runsIncluded} runs, ${
        s.healthScore != null ? (s.healthScore * 100).toFixed(0) + "%" : "N/A"
      }, ${s.overall_health ?? "?"})`)
    .join(" → ");

  const prompt = `You are comparing ${analyses.length} QA analysis versions for the same AI voice agent.
Chronological order: ${versionLine}

${summaries.map((s) => `VERSION ${s.version}:\n${JSON.stringify(s, null, 2)}`).join("\n\n")}

Produce a comprehensive multi-version comparison. Respond with JSON only:
{
  "overall_trajectory": "Improving" | "Declining" | "Mixed" | "Stable",
  "summary": "3-4 sentences on the overall progress arc across these ${analyses.length} versions",
  "persistent_issues": [
    {
      "area": "string",
      "detail": "still present across all compared versions",
      "severity": "High" | "Medium" | "Low"
    }
  ],
  "resolved_issues": [
    {
      "area": "string",
      "fixed_in": "vN",
      "detail": "how the issue stopped appearing"
    }
  ],
  "regressions": [
    {
      "area": "string",
      "appeared_in": "vN",
      "detail": "what got worse and likely why"
    }
  ],
  "improvements": [
    {
      "area": "string",
      "detail": "measurable or qualitative improvement observed"
    }
  ],
  "version_by_version": [
    {
      "from": "vN",
      "to": "vM",
      "key_changes": ["one-liner change"]
    }
  ],
  "top_remaining_priorities": ["most urgent unresolved issue", "second", "third"]
}`;

  const response = await openai.chat.completions.create({
    model:           "gpt-4.1",
    messages:        [{ role: "user", content: prompt }],
    response_format: { type: "json_object" },
    temperature:     0,
    max_tokens:      4000, // bumped from 3000 — 6-version comparison can be verbose
  });

  const usage = response.usage;
  const cost = usage ? calcCost(usage.prompt_tokens, usage.completion_tokens) : 0;

  const raw = response.choices[0]?.message?.content;
  if (!raw) throw new Error("LLM returned empty comparison");

  // Detect truncated output before attempting JSON parse
  const finishReason = response.choices[0]?.finish_reason;
  if (finishReason === "length") {
    throw new Error("LLM response was truncated (too many versions or findings). Try comparing fewer versions.");
  }

  let comparison: any;
  try { comparison = JSON.parse(raw); }
  catch { throw new Error("Failed to parse LLM comparison response"); }

  return { analyses, summaries, comparison, cost };
}

// ── Per-project analysis ────────────────────────────────────────────────────

export async function analyzeProject(projectId: string, filter?: AnalysisFilter) {
  // ── 1. Fetch project ────────────────────────────────────────────
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    include: { criteria: true },
  });
  if (!project) throw new Error("Project not found");

  // ── 2. Build run filter ─────────────────────────────────────────
  const runWhere: any = { projectId, status: "COMPLETE" };

  if (filter?.dateFilterType && (filter.from || filter.to)) {
    const field = filter.dateFilterType === "CALL_DATE" ? "callDate" : "completedAt";
    runWhere[field] = {};
    if (filter.from) {
      runWhere[field].gte = new Date(filter.from + "T00:00:00.000Z");
    }
    if (filter.to) {
      runWhere[field].lte = new Date(filter.to + "T23:59:59.999Z");
    }
  }

  // ── 3. Fetch runs (cap at 100 for prompt size) ──────────────────
  const runs = await prisma.run.findMany({
    where: runWhere,
    include: {
      evalResults: { include: { criterion: true } },
      wordLabels:  true,
    },
    orderBy: { completedAt: "desc" },
    take: 100,
  });

  if (runs.length < 3) {
    throw new Error(
      `At least 3 evaluated runs are required (found ${runs.length} matching the filter)`
    );
  }

  // ── 4. Aggregate stats ──────────────────────────────────────────

  // 4a — Per-criterion performance
  const criterionStats = new Map<string, {
    label: string; type: string; scores: number[]; passed: number; total: number;
  }>();
  for (const run of runs) {
    for (const er of run.evalResults) {
      const key = er.criterionId;
      if (!criterionStats.has(key)) {
        criterionStats.set(key, {
          label:  er.criterion.label || er.criterion.key,
          type:   er.criterion.type,
          scores: [], passed: 0, total: 0,
        });
      }
      const s = criterionStats.get(key)!;
      s.total++;
      if (er.score  != null) s.scores.push(er.score);
      if (er.passed === true) s.passed++;
    }
  }

  // 4b — ACTION_CONSISTENCY error aggregation
  const acByRootCause = new Map<string, { count: number; runIds: string[] }>();
  const acByCategory  = new Map<string, number>();

  for (const run of runs) {
    const ac = run.evalResults.find((er: any) => er.criterion.type === "ACTION_CONSISTENCY");
    if (!ac?.metadata) continue;
    const errors: any[] = (ac.metadata as any).errors || [];
    for (const err of errors) {
      const rc = err.root_cause || "UNKNOWN";
      if (!acByRootCause.has(rc)) acByRootCause.set(rc, { count: 0, runIds: [] });
      const entry = acByRootCause.get(rc)!;
      entry.count++;
      if (!entry.runIds.includes(run.id)) entry.runIds.push(run.id);

      if (err.category) {
        acByCategory.set(err.category, (acByCategory.get(err.category) || 0) + 1);
      }
    }
  }

  // 4c — FLOW_PROGRESSION failed transitions
  type TransitionEntry = { count: number; runIds: string[]; examples: any[] };
  const transitionMap = new Map<string, TransitionEntry>();

  for (const run of runs) {
    const fp = run.evalResults.find((er: any) => er.criterion.type === "FLOW_PROGRESSION");
    if (!fp?.detail) continue;
    try {
      const parsed = JSON.parse(fp.detail as string);
      for (const ft of (parsed.failed_transitions || [])) {
        const key = `${ft.expected_action || "?"}|||${ft.actual_action || "?"}`;
        if (!transitionMap.has(key)) transitionMap.set(key, { count: 0, runIds: [], examples: [] });
        const entry = transitionMap.get(key)!;
        entry.count++;
        if (!entry.runIds.includes(run.id)) entry.runIds.push(run.id);
        if (entry.examples.length < 3) entry.examples.push({ ...ft, runId: run.id });
      }
    } catch { /* malformed detail — skip */ }
  }

  // 4d — Goal distribution
  let goalSuccessful = 0, goalPartial = 0, goalFailed = 0;
  for (const run of runs) {
    const g = computeGoalStatus(run);
    if (g === "SUCCESSFUL") goalSuccessful++;
    else if (g === "PARTIAL") goalPartial++;
    else if (g === "FAILED") goalFailed++;
  }

  // 4e — Word labels
  let llmErrors = 0, ttsErrors = 0, asrErrors = 0,
      wrongLang = 0, wrongGender = 0, hallucinated = 0;
  for (const run of runs) {
    for (const wl of run.wordLabels) {
      if      (wl.labelType === "LLM_ERROR")      llmErrors++;
      else if (wl.labelType === "TTS_ERROR")      ttsErrors++;
      else if (wl.labelType === "ASR_ERROR")      asrErrors++;
      else if (wl.labelType === "WRONG_LANGUAGE") wrongLang++;
      else if (wl.labelType === "WRONG_GENDER")   wrongGender++;
      else if (wl.labelType === "HALLUCINATED")   hallucinated++;
    }
  }

  // ── 5. Build prompt sections ────────────────────────────────────

  // Criterion table
  let criterionTable = "CRITERION PERFORMANCE (across all included runs):\n";
  for (const [, s] of criterionStats) {
    const avg = s.scores.length > 0
      ? (s.scores.reduce((a, b) => a + b, 0) / s.scores.length * 100).toFixed(0) + "%"
      : "N/A";
    const passRate = s.total > 0 ? (s.passed / s.total * 100).toFixed(0) + "%" : "N/A";
    criterionTable += `  ${s.label} (${s.type}): avg ${avg}, pass rate ${passRate} (${s.passed}/${s.total} runs)\n`;
  }

  // Error patterns
  let errorSection = "AGGREGATED ACTION_CONSISTENCY ERROR PATTERNS:\n";
  const sortedAC = [...acByRootCause.entries()].sort((a, b) => b[1].count - a[1].count);
  for (const [cause, data] of sortedAC) {
    errorSection += `  ${cause}: ${data.count} occurrences across ${data.runIds.length} runs\n`;
  }

  if (acByCategory.size > 0) {
    errorSection += "  Breakdown by category:\n";
    const sortedCat = [...acByCategory.entries()].sort((a, b) => b[1] - a[1]);
    for (const [cat, count] of sortedCat) {
      errorSection += `    ${cat}: ${count}\n`;
    }
  }

  errorSection += "\nREPEATED FAILED TRANSITIONS (FLOW_PROGRESSION):\n";
  const sortedTrans = [...transitionMap.values()].sort((a, b) => b.count - a.count).slice(0, 10);
  for (const entry of sortedTrans) {
    const ex = entry.examples[0];
    if (!ex) continue;
    errorSection += `  [${entry.count} calls] User said: "${ex.user_said || "?"}" `
      + `→ expected: "${ex.expected_action || "?"}" `
      + `→ actual: "${ex.actual_action || "?"}"\n`;
  }

  // Goal + label summaries
  const n = runs.length;
  const goalSection = `GOAL ACHIEVEMENT:
  Successful: ${goalSuccessful}/${n} (${(goalSuccessful / n * 100).toFixed(0)}%)
  Partial:    ${goalPartial}/${n}    (${(goalPartial    / n * 100).toFixed(0)}%)
  Failed:     ${goalFailed}/${n}     (${(goalFailed     / n * 100).toFixed(0)}%)\n`;

  const labelSection = `HUMAN-ANNOTATED WORD ERRORS:
  LLM errors: ${llmErrors} | TTS errors: ${ttsErrors} | ASR errors: ${asrErrors}
  Wrong language: ${wrongLang} | Wrong gender: ${wrongGender} | Hallucinated: ${hallucinated}\n`;

  // Worst & best calls for evidence
  // With small n (e.g. 3–8 runs), the worst and best slices would overlap,
  // making the "contrast" section redundant. Deduplicate by excluding worstRun ids from bestRuns.
  const sorted      = [...runs].sort((a, b) => (a.overallScore ?? 0) - (b.overallScore ?? 0));
  const worstCount  = Math.min(5, n);
  const worstRuns   = sorted.slice(0, worstCount);
  const worstIds    = new Set(worstRuns.map((r) => r.id));
  const remaining   = sorted.filter((r) => !worstIds.has(r.id));
  const bestRuns    = remaining.slice(-Math.min(3, remaining.length)).reverse();

  function buildCallEvidence(callRuns: typeof runs, label: string): string {
    let out = `${label}:\n`;
    for (const run of callRuns) {
      const date  = run.callDate ? new Date(run.callDate).toISOString().split("T")[0]
                  : run.completedAt ? new Date(run.completedAt).toISOString().split("T")[0]
                  : "unknown";
      out += `\n[run_id: ${run.id}, date: ${date}, score: ${
        run.overallScore != null ? (run.overallScore * 100).toFixed(0) + "%" : "N/A"
      }, outcome: ${run.callOutcome || "none"}]\n`;

      // ACTION_CONSISTENCY errors
      const ac = run.evalResults.find((er: any) => er.criterion.type === "ACTION_CONSISTENCY");
      if (ac?.metadata) {
        const errors: any[] = (ac.metadata as any).errors || [];
        for (const err of errors.slice(0, 4)) {
          out += `  [${(err.severity || "?").toUpperCase()}] ${err.category || "?"}: `;
          if (err.what_agent_said) out += `Agent said "${err.what_agent_said.slice(0, 100)}" `;
          if (err.what_log_shows)  out += `— log shows: "${err.what_log_shows.slice(0, 80)}" `;
          out += `| root cause: ${err.root_cause || "?"}\n`;
          if (err.suggested_fix)  out += `    Fix: ${err.suggested_fix}\n`;
        }
      }

      // FLOW_PROGRESSION summary
      const fp = run.evalResults.find((er: any) => er.criterion.type === "FLOW_PROGRESSION");
      if (fp?.detail) {
        try {
          const parsed = JSON.parse(fp.detail as string);
          if (parsed.stuck_on_node) {
            out += `  STUCK on node: "${parsed.stuck_on_node}" (${parsed.stuck_turns || "?"} turns)\n`;
          }
          if ((parsed.failed_transitions || []).length > 0) {
            out += `  Failed transitions: ${parsed.failed_transitions.length}\n`;
          }
        } catch { /* skip */ }
      }
    }
    return out;
  }

  const worstSection = buildCallEvidence(worstRuns, "WORST PERFORMING CALLS (primary evidence source)");
  // Only include best-call section when there are non-worst runs to contrast against.
  // When bestRuns is empty (e.g. all runs scored poorly), including the header with
  // no bodies wastes tokens and can confuse the LLM.
  const bestSection  = bestRuns.length > 0
    ? buildCallEvidence(bestRuns, "BEST PERFORMING CALLS (for contrast)")
    : "";

  // Agent structure
  const agentStruct = project.agentStructure as any;
  let agentSection = "";
  if (agentStruct) {
    agentSection = "AGENT STRUCTURE (map failures to specific nodes/prompt text):\n";
    if (agentStruct.conversation?.preamble) {
      const p = agentStruct.conversation.preamble as string;
      agentSection += `PREAMBLE:\n${p.slice(0, 1000)}${p.length > 1000 ? "\n[truncated]" : ""}\n\n`;
    }
    if (Array.isArray(agentStruct.workflow?.nodes)) {
      agentSection += "NODES:\n";
      for (const node of agentStruct.workflow.nodes as any[]) {
        agentSection += `- "${node.label}" (${node.type})\n`;
        if (node.message) {
          const m = node.message as string;
          agentSection += `  Prompt: ${m.slice(0, 250)}${m.length > 250 ? "..." : ""}\n`;
        }
        if (Array.isArray(node.transitions)) {
          for (const t of node.transitions) {
            const cond = t.condition?.description || t.condition?.prompt || "auto";
            agentSection += `  → Transition: "${cond}"\n`;
          }
        }
        if (Array.isArray(node.extractVariables?.variables)) {
          agentSection += `  Extracts: ${node.extractVariables.variables.map((v: any) => v.name).join(", ")}\n`;
        }
      }
    }
    if (Array.isArray(agentStruct.tools)) {
      agentSection += "\nTOOLS:\n";
      for (const t of agentStruct.tools as any[]) {
        agentSection += `- ${t.name || t.id}: ${t.description || ""}\n`;
      }
    }
  }

  const agentSummarySection = project.agentSummary
    ? `AGENT CONTEXT (purpose, flow, success criteria):\n${project.agentSummary}\n\n` : "";

  // ── 6. Fetch previous version BEFORE any LLM call ──────────────
  // Must happen before we start the main LLM request so the comparison
  // baseline is stable: if another analysis were to complete while the
  // LLM call is in-flight (e.g. a second server process), we'd compare
  // against the wrong version. The in-process Set guard prevents this
  // for single-process deployments; fetching early also makes the
  // nextVersion calculation deterministic.
  const previousVersion = await prisma.projectAnalysis.findFirst({
    where:   { projectId },
    orderBy: { version: "desc" },
    select:  { version: true, analysis: true, healthScore: true },
  });

  // ── 7. Build and call LLM ───────────────────────────────────────
  const prompt = `You are a senior QA analyst reviewing ${n} calls from an AI voice agent.
Your goal: identify systemic issues, map root causes to specific nodes or prompt text, and give precise actionable recommendations.

${agentSummarySection}${criterionTable}
${goalSection}
${errorSection}
${labelSection}
${agentSection}
${worstSection}
${bestSection}

TASK: Produce a structured analysis. For each finding:
- Reference exact node names or preamble sections when the failure maps to the agent config
- Include evidence with the exact run_id from the data above (copy exactly)
- Suggested fixes must be specific — quote the text to add/change in the prompt/node

Respond with JSON only:
{
  "overall_health": "Good" | "Fair" | "Poor",
  "health_score": 0.0-1.0,
  "executive_summary": "2-3 sentence overview of agent performance across these ${n} calls",
  "best_parts": [
    {
      "area": "string",
      "detail": "string",
      "evidence": [{ "run_id": "string", "call_date": "YYYY-MM-DD", "quote": "string" }]
    }
  ],
  "critical_failures": [
    {
      "area": "string — name the specific node, criterion, or behavior",
      "frequency": "N of ${n} calls",
      "root_cause": "string",
      "detail": "string",
      "prompt_location": "Preamble | Node 'X' | Tool 'Y' | null",
      "suggested_fix": "specific fix — include exact text to add or change in the node prompt",
      "evidence": [{ "run_id": "string", "call_date": "YYYY-MM-DD", "quote": "string" }]
    }
  ],
  "missing_edge_cases": [
    {
      "scenario": "string",
      "frequency": "string",
      "impact": "string",
      "suggested_handling": "string — describe what node/transition/text to add",
      "evidence": [{ "run_id": "string", "call_date": "YYYY-MM-DD", "quote": "string" }]
    }
  ],
  "prompt_issues": [
    {
      "location": "Preamble | Node 'X'",
      "issue": "string",
      "suggested_fix": "string — include the exact text to add or modify"
    }
  ],
  "priority_actions": ["top fix", "second fix", "third fix"]
}`;

  const llmResponse = await openai.chat.completions.create({
    model:           "gpt-4.1",
    messages:        [{ role: "user", content: prompt }],
    response_format: { type: "json_object" },
    temperature:     0,
    max_tokens:      4000,
  });

  const usage1 = llmResponse.usage;
  let totalCost = usage1 ? calcCost(usage1.prompt_tokens, usage1.completion_tokens) : 0;

  const rawContent = llmResponse.choices[0]?.message?.content;
  if (!rawContent) throw new Error("LLM returned empty analysis");

  let analysisResult: any;
  try { analysisResult = JSON.parse(rawContent); }
  catch { throw new Error("Failed to parse LLM analysis response"); }

  // ── 8. Compare with previous version ───────────────────────────
  let comparison: any = null;

  if (previousVersion) {
    // Extract only the structured summary fields for comparison — slicing raw
    // JSON can cut through a string value mid-way, giving the LLM malformed context.
    const prevSummary = {
      overall_health:    (previousVersion.analysis as any).overall_health,
      health_score:      (previousVersion.analysis as any).health_score,
      executive_summary: (previousVersion.analysis as any).executive_summary,
      priority_actions:  (previousVersion.analysis as any).priority_actions,
      critical_failures: ((previousVersion.analysis as any).critical_failures || []).map((f: any) => ({
        area: f.area, frequency: f.frequency, root_cause: f.root_cause, detail: f.detail,
      })),
      missing_edge_cases: ((previousVersion.analysis as any).missing_edge_cases || []).map((e: any) => ({
        scenario: e.scenario, frequency: e.frequency,
      })),
      prompt_issues: ((previousVersion.analysis as any).prompt_issues || []).map((p: any) => ({
        location: p.location, issue: p.issue,
      })),
      best_parts: ((previousVersion.analysis as any).best_parts || []).map((b: any) => ({
        area: b.area,
      })),
    };
    const currSummary = {
      overall_health:    analysisResult.overall_health,
      health_score:      analysisResult.health_score,
      executive_summary: analysisResult.executive_summary,
      priority_actions:  analysisResult.priority_actions,
      critical_failures: (analysisResult.critical_failures || []).map((f: any) => ({
        area: f.area, frequency: f.frequency, root_cause: f.root_cause, detail: f.detail,
      })),
      missing_edge_cases: (analysisResult.missing_edge_cases || []).map((e: any) => ({
        scenario: e.scenario, frequency: e.frequency,
      })),
      prompt_issues: (analysisResult.prompt_issues || []).map((p: any) => ({
        location: p.location, issue: p.issue,
      })),
      best_parts: (analysisResult.best_parts || []).map((b: any) => ({
        area: b.area,
      })),
    };

    const compPrompt = `You are comparing two QA analyses of the same AI voice agent.

VERSION ${previousVersion.version} (PREVIOUS):
${JSON.stringify(prevSummary, null, 2)}

VERSION ${previousVersion.version + 1} (CURRENT):
${JSON.stringify(currSummary, null, 2)}

Identify what changed between versions. Respond with JSON only:
{
  "improvements": [
    { "area": "string", "detail": "string — what changed and why it improved" }
  ],
  "regressions": [
    { "area": "string", "detail": "string — what got worse and likely why" }
  ],
  "unchanged_issues": [
    { "area": "string", "detail": "still present from v${previousVersion.version}, not yet fixed" }
  ],
  "new_issues": [
    { "area": "string", "detail": "appeared in this version, not in previous" }
  ],
  "summary": "2-3 sentence summary of overall progress from v${previousVersion.version} to v${previousVersion.version + 1}"
}`;

    const compResponse = await openai.chat.completions.create({
      model:           "gpt-4.1",
      messages:        [{ role: "user", content: compPrompt }],
      response_format: { type: "json_object" },
      temperature:     0,
      max_tokens:      2000,
    });

    const usage2 = compResponse.usage;
    if (usage2) totalCost += calcCost(usage2.prompt_tokens, usage2.completion_tokens);

    try { comparison = JSON.parse(compResponse.choices[0]?.message?.content || "{}"); }
    catch { comparison = null; }
  }

  // ── 8. Persist and return ───────────────────────────────────────
  const nextVersion = (previousVersion?.version ?? 0) + 1;

  const filterFrom = filter?.from
    ? new Date(filter.from + "T00:00:00.000Z") : null;
  const filterTo   = filter?.to
    ? new Date(filter.to   + "T23:59:59.999Z") : null;

  const saved = await prisma.projectAnalysis.create({
    data: {
      projectId,
      version:           nextVersion,
      runIds:            runs.map((r) => r.id),
      runsIncluded:      runs.length,
      dateFilterType:    filter?.dateFilterType ?? null,
      filterFrom,
      filterTo,
      analysis:          analysisResult,
      healthScore:       analysisResult.health_score ?? null,
      comparedToVersion: previousVersion?.version ?? null,
      comparison,
      analysisCost:      totalCost,
    },
  });

  return saved;
}
