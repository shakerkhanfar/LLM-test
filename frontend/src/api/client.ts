const API_BASE = "/api";

function getToken(): string | null {
  return localStorage.getItem("hamsa_eval_token");
}

// Guard against multiple simultaneous 401 responses all triggering a redirect.
// Auto-resets after 5 s so that a navigation-abort doesn't permanently suppress redirects.
let redirectingToLogin = false;

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const hasBody = options?.body != null;
  const token = getToken();
  const res = await fetch(`${API_BASE}${path}`, {
    headers: {
      ...(hasBody ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...options,
  });
  if (res.status === 401) {
    // Token expired or invalid — clear session and redirect to login (once).
    localStorage.removeItem("hamsa_eval_token");
    localStorage.removeItem("hamsa_eval_user");
    if (!redirectingToLogin) {
      redirectingToLogin = true;
      setTimeout(() => { redirectingToLogin = false; }, 5000);
      window.location.href = "/login";
    }
    throw new Error("Session expired. Please sign in again.");
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API error ${res.status}: ${text}`);
  }
  try {
    return await res.json();
  } catch {
    throw new Error(`API returned non-JSON response from ${path}`);
  }
}

// ─── Projects ──────────────────────────────────────────────────────

export function listProjects() {
  return request<any[]>("/projects");
}

export function getProject(id: string, before?: string) {
  const qs = before ? `?before=${before}` : "";
  return request<any>(`/projects/${id}${qs}`);
}

export function createProject(data: {
  name: string;
  agentId: string;
  hamsaApiKey?: string;
  description?: string;
  agentStructure?: any;
  criteria?: any[];
  projectType?: "LIVE" | "HISTORY" | "WEBHOOK" | "TECH_SUPPORT" | "INGEST";
  historyStartDate?: string;
  historyEndDate?: string;
}) {
  return request<any>("/projects", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

// POST so the API key is not in the URL / server logs
export function fetchAgentPreview(agentId: string, apiKey?: string) {
  return request<any>("/projects/agent-preview", {
    method: "POST",
    body: JSON.stringify({ agentId, apiKey }),
  });
}

export function fetchHamsaProjects(apiKey: string, agentId?: string) {
  return request<any>("/projects/hamsa-projects", {
    method: "POST",
    body: JSON.stringify({ apiKey, agentId }),
  });
}

export function refreshAgent(projectId: string) {
  return request<any>(`/projects/${projectId}/refresh-agent`, { method: "POST" });
}

export function deleteProject(id: string) {
  return request<any>(`/projects/${id}`, { method: "DELETE" });
}

export function updateProject(
  id: string,
  data: { name?: string; description?: string; agentStructure?: any; evaluationEnabled?: boolean }
) {
  return request<any>(`/projects/${id}`, { method: "PATCH", body: JSON.stringify(data) });
}

export function addCriterion(projectId: string, data: any) {
  return request<any>(`/projects/${projectId}/criteria`, {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export function deleteCriterion(projectId: string, criterionId: string) {
  return request<any>(`/projects/${projectId}/criteria/${criterionId}`, {
    method: "DELETE",
  });
}

// ─── Runs ──────────────────────────────────────────────────────────

export function listRuns(projectId: string, skip = 0, take = 100, status?: string) {
  const params = new URLSearchParams({ skip: String(skip), take: String(take) });
  if (status) params.set("status", status);
  return request<any[]>(`/runs/project/${projectId}?${params}`);
}

export function getRun(id: string) {
  return request<any>(`/runs/${id}`);
}

/** Fetch a fresh recording URL from Hamsa (the stored CloudFront URL may have expired). */
export function getRecordingUrl(runId: string) {
  return request<{ url: string }>(`/runs/${runId}/recording-url`);
}

export function createRun(data: { projectId: string; modelUsed: string }) {
  return request<any>("/runs", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export function deleteRun(id: string) {
  return request<any>(`/runs/${id}`, { method: "DELETE" });
}

export function attachCallLog(runId: string, callLog: any) {
  return request<any>(`/runs/${runId}/call-log`, {
    method: "POST",
    body: JSON.stringify({ callLog }),
  });
}

export function attachTranscript(
  runId: string,
  transcript: any,
  webhookData?: any
) {
  return request<any>(`/runs/${runId}/transcript`, {
    method: "POST",
    body: JSON.stringify({ transcript, webhookData }),
  });
}

export function triggerEvaluation(runId: string) {
  return request<any>(`/runs/${runId}/evaluate`, { method: "POST" });
}

export function fetchLogs(runId: string) {
  return request<any>(`/runs/${runId}/fetch-logs`, { method: "POST" });
}

export function rehydrateRun(runId: string) {
  return request<{ ok: boolean; logEvents: number; transcriptTurns: number; warnings?: string[] }>(
    `/runs/${runId}/rehydrate`,
    { method: "POST" }
  );
}

export function switchModel(runId: string) {
  return request<any>(`/runs/${runId}/switch-model`, { method: "POST" });
}

export function updateRun(runId: string, data: any) {
  return request<any>(`/runs/${runId}`, {
    method: "PATCH",
    body: JSON.stringify(data),
  });
}

export function compareRuns(runIds: string[]) {
  return request<any[]>("/runs/compare", {
    method: "POST",
    body: JSON.stringify({ runIds }),
  });
}

// ─── Labels ────────────────────────────────────────────────────────

export function getLabels(runId: string) {
  return request<any[]>(`/labels/run/${runId}`);
}

export function createLabel(runId: string, data: any) {
  return request<any>(`/labels/run/${runId}`, {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export function deleteLabel(id: string) {
  return request<any>(`/labels/${id}`, { method: "DELETE" });
}

// ─── Project Analysis ──────────────────────────────────────────────

export function runProjectAnalysis(
  projectId: string,
  filter?: { dateFilterType?: "CALL_DATE" | "EVAL_DATE"; from?: string; to?: string }
) {
  return request<any>(`/projects/${projectId}/analyze`, {
    method: "POST",
    body: JSON.stringify(filter ?? {}),
  });
}

export function listProjectAnalyses(projectId: string) {
  return request<any[]>(`/projects/${projectId}/analyses`);
}

export function deleteProjectAnalysis(projectId: string, analysisId: string) {
  return request<any>(`/projects/${projectId}/analyses/${analysisId}`, { method: "DELETE" });
}

export function compareProjectAnalyses(projectId: string, analysisIds: string[]) {
  return request<any>(`/projects/${projectId}/analyses/compare`, {
    method: "POST",
    body: JSON.stringify({ analysisIds }),
  });
}

// ─── History ───────────────────────────────────────────────────────

export function importHistory(
  projectId: string,
  options: {
    period?: string;
    startDate?: string;
    endDate?: string;
    status?: string;
    limit?: number;
  } = {}
) {
  // Include the browser's UTC offset so the server can compute correct local-midnight
  // timestamps. new Date().getTimezoneOffset() returns minutes *behind* UTC (negative
  // for east-of-UTC timezones, e.g. -180 for UTC+3). We negate it so the server
  // receives a positive value for zones ahead of UTC.
  const timezoneOffsetMinutes = -new Date().getTimezoneOffset();
  return request<any>(`/history/${projectId}/import`, {
    method: "POST",
    body: JSON.stringify({ ...options, timezoneOffsetMinutes }),
  });
}

export function importHistoryCsv(
  projectId: string,
  options: {
    hamsaProjectId: string;
    startDate?: string;
    endDate?: string;
    limit?: number;
    apiBaseUrl?: string;
  }
) {
  return request<any>(`/history/${projectId}/import-csv`, {
    method: "POST",
    body: JSON.stringify(options),
  });
}

export async function exportProjectBundle(projectId: string, projectName: string) {
  const token = getToken();
  const res = await fetch(`/api/projects/${projectId}/full-export`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) throw new Error(`Export failed: ${res.status}`);
  const blob = await res.blob();
  const url = window.URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${projectName.replace(/[^a-zA-Z0-9]/g, "_")}_export.json`;
  a.click();
  window.URL.revokeObjectURL(url);
}

export async function importProjectBundle(
  bundles: any[],
): Promise<{ projectId: string; name: string; imported: number; warning?: string; warnings?: string[] }> {
  const token = getToken();
  // Single bundle = legacy shape; 2+ = merge mode wrapped in { bundles }
  const body = bundles.length === 1 ? JSON.stringify(bundles[0]) : JSON.stringify({ bundles });
  const res = await fetch("/api/projects/import-bundle", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Import failed: ${res.status}`);
  }
  return res.json();
}

export async function exportCallIds(projectId: string, projectName: string) {
  const token = getToken();
  const res = await fetch(`/api/projects/${projectId}/export-call-ids`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) throw new Error(`Export failed: ${res.status}`);
  const blob = await res.blob();
  const url = window.URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${projectName.replace(/[^a-zA-Z0-9]/g, "_")}_call_ids.csv`;
  a.click();
  window.URL.revokeObjectURL(url);
}

export function importByIds(projectId: string, conversationIds: string[]) {
  return request<any>(`/history/${projectId}/import-ids`, {
    method: "POST",
    body: JSON.stringify({ conversationIds }),
  });
}

export function getHistoryStatus(projectId: string) {
  return request<any>(`/history/${projectId}/status`);
}

export function reEvaluateProject(projectId: string) {
  return request<any>(`/projects/${projectId}/re-evaluate`, { method: "POST" });
}

export function reEvaluateRuns(projectId: string, runIds: string[]) {
  return request<{ ok: boolean; resetCount: number }>(`/projects/${projectId}/re-evaluate-runs`, {
    method: "POST",
    body: JSON.stringify({ runIds }),
  });
}

export function rehydrateRuns(projectId: string, runIds: string[]) {
  return request<{
    ok: boolean;
    acceptedRunIds: string[];
    skippedNoIdsCount: number;
    notFoundCount: number;
  }>(`/projects/${projectId}/rehydrate-runs`, {
    method: "POST",
    body: JSON.stringify({ runIds }),
  });
}

export function reEvaluateFailedProject(projectId: string) {
  return request<{ ok: boolean; resetCount: number }>(`/projects/${projectId}/re-evaluate-failed`, { method: "POST" });
}

// ─── MCP Access Tokens ───────────────────────────────────────────────
export interface McpTokenSummary {
  id: string;
  name: string | null;
  scope: "read" | "read_write" | string;
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdByUserId: string | null;
}

export function listMcpTokens(projectId: string) {
  return request<{ tokens: McpTokenSummary[] }>(`/projects/${projectId}/mcp-tokens`);
}

export function issueMcpToken(
  projectId: string,
  body: { name?: string | null; scope?: "read" | "read_write"; ttlDays?: number | null } = {}
) {
  return request<{ id: string; token: string; createdAt: string; expiresAt: string | null }>(
    `/projects/${projectId}/mcp-tokens`,
    { method: "POST", body: JSON.stringify(body) }
  );
}

export function revokeMcpToken(projectId: string, tokenId: string) {
  return request<{ ok: boolean; revoked: boolean }>(
    `/projects/${projectId}/mcp-tokens/${tokenId}`,
    { method: "DELETE" }
  );
}

export function reEvaluateErrorsProject(projectId: string) {
  return request<{ ok: boolean; resetCount: number }>(`/projects/${projectId}/re-evaluate-errors`, { method: "POST" });
}

export function reHydrateProject(projectId: string) {
  return request<any>(`/projects/${projectId}/re-hydrate`, { method: "POST" });
}

// ─── Ask (natural language search) ───────────────────────────────

export function askProject(projectId: string, question: string) {
  return request<any>(`/projects/${projectId}/ask`, {
    method: "POST",
    body: JSON.stringify({ question }),
  });
}

// ─── Tool Result Search ───────────────────────────────────────────

export interface ToolMatch {
  toolName: string;
  request: any;
  response: any;
  status: "success" | "error" | "unknown";
  matchesQuery: boolean;
}

export interface ToolSearchResult {
  id: string;
  hamsaCallId: string | null;
  conversationId: string | null;
  callDate: string | null;
  callDuration: number | null;
  callOutcome: string | null;
  callStatus: string | null;
  overallScore: number | null;
  matchCount: number;
  toolMatches: ToolMatch[];
}

export function searchToolResults(projectId: string, query: string) {
  return request<{ query: string; total: number; hasMore: boolean; results: ToolSearchResult[] }>(
    `/projects/${projectId}/tool-search`,
    { method: "POST", body: JSON.stringify({ query }) }
  );
}

// ─── Eval Context & Prompt Audit ────────────────────────────────────

export function getEvalContext(projectId: string) {
  return request<{ evalContext: string }>(`/projects/${projectId}/eval-context`);
}

export function saveEvalContext(projectId: string, evalContext: string) {
  return request<{ evalContext: string }>(`/projects/${projectId}/eval-context`, {
    method: "PATCH",
    body: JSON.stringify({ evalContext }),
  });
}

export function runPromptAudit(projectId: string, instructions?: string) {
  return request<any>(`/projects/${projectId}/prompt-audit`, {
    method: "POST",
    body: JSON.stringify({ instructions: instructions || "" }),
  });
}

export function applyPromptFix(projectId: string, nodeId: string, prompt: string) {
  return request<{ ok: boolean; nodeId: string; nodeLabel: string }>(
    `/projects/${projectId}/prompt-audit/apply`,
    { method: "POST", body: JSON.stringify({ nodeId, prompt }) }
  );
}

export function getProjectDashboard(projectId: string, dateFilter?: { from: string; to: string } | null) {
  const params = new URLSearchParams();
  if (dateFilter?.from) params.set("from", dateFilter.from);
  if (dateFilter?.to) params.set("to", dateFilter.to);
  const qs = params.toString() ? `?${params}` : "";
  return request<any>(`/projects/${projectId}/dashboard${qs}`);
}

export function getRunsByIds(projectId: string, ids: string[]) {
  return request<any[]>(`/projects/${projectId}/runs-by-ids`, {
    method: "POST",
    body: JSON.stringify({ ids }),
  });
}

export function getProjectReport(projectId: string, days = 7) {
  return request<any>(`/projects/${projectId}/report?days=${days}`);
}

export function generateIntelligenceReport(
  projectId: string,
  filter?: { from?: string; to?: string }
) {
  return request<any>(`/projects/${projectId}/report/intelligence`, {
    method: "POST",
    body: JSON.stringify(filter ?? {}),
  });
}

export function getObjectiveFailures(projectId: string, range?: { from?: string; to?: string }) {
  const qs = new URLSearchParams();
  if (range?.from) qs.set("from", range.from);
  if (range?.to)   qs.set("to",   range.to);
  const suffix = qs.toString() ? `?${qs.toString()}` : "";
  return request<{
    totalEvaluated: number;
    totalNotAchieved: number;
    failures: Array<{
      runId: string;
      conversationId: string | null;
      callDate: string | null;
      callOutcome: string | null;
      reason: string;
      reasonSource: "summary" | "criticalIssue" | "experienceIssue" | "unknown";
    }>;
    failuresTruncated: boolean;
    reasonGroups: Array<{ reason: string; count: number; runIds: string[] }>;
  }>(`/projects/${projectId}/objective-failures${suffix}`);
}

// ─── Intention funnel ─────────────────────────────────────────────

export type FunnelSuccessMode = "values" | "present" | "objective";
export interface FunnelConfig {
  intentField: string | null;
  successField: string | null;
  successMode: FunnelSuccessMode;
  successValues: string[];
}

export function getFunnelConfig(projectId: string) {
  return request<{
    config: FunnelConfig;
    columns: string[];
    columnValues: Record<string, string[]>;
    saved: boolean;
  }>(`/projects/${projectId}/funnel-config`);
}

export function saveFunnelConfig(projectId: string, config: FunnelConfig) {
  return request<{ config: FunnelConfig }>(`/projects/${projectId}/funnel-config`, {
    method: "PUT",
    body: JSON.stringify({ config }),
  });
}

export interface OutcomeFunnelRow {
  intention: string;
  started: number;
  succeeded: number;
  failed: number;
  incomplete: number;
  successRate: number | null;
}

function funnelQuery(range?: { from?: string; to?: string }, config?: FunnelConfig | null): string {
  const qs = new URLSearchParams();
  if (range?.from) qs.set("from", range.from);
  if (range?.to) qs.set("to", range.to);
  if (config?.intentField) {
    qs.set("intentField", config.intentField);
    qs.set("successMode", config.successMode);
    if (config.successField) qs.set("successField", config.successField);
    if (config.successValues.length) qs.set("successValues", config.successValues.join(","));
  }
  return qs.toString() ? `?${qs}` : "";
}

export function getOutcomeFunnel(
  projectId: string,
  range?: { from?: string; to?: string },
  config?: FunnelConfig | null
) {
  return request<{ config: FunnelConfig; rows: OutcomeFunnelRow[] }>(
    `/projects/${projectId}/outcome-funnel${funnelQuery(range, config)}`
  );
}

export interface NodeFunnelStage {
  nodeLabel: string;
  nodeType: string;
  reached: number;
  droppedAfter: number;
  dropPct: number;
  stuckCount: number;
  hallucinationCount: number;
}
export interface NodeFunnelIntention {
  intention: string;
  total: number;
  completed: number;
  stages: NodeFunnelStage[];
}

export function getIntentionNodeFunnel(
  projectId: string,
  range?: { from?: string; to?: string },
  config?: FunnelConfig | null
) {
  return request<{
    intentField: string | null;
    hasFlowGraph: boolean;
    capped: boolean;
    runWindow: number;
    intentions: NodeFunnelIntention[];
    note?: string;
  }>(`/projects/${projectId}/intention-node-funnel${funnelQuery(range, config)}`);
}

// Full server-side CSV export of all complete runs in range (auth header → blob download).
export async function exportOutcomesCsv(
  projectId: string,
  projectName: string,
  range?: { from?: string; to?: string }
) {
  const token = getToken();
  const qs = new URLSearchParams();
  if (range?.from) qs.set("from", range.from);
  if (range?.to) qs.set("to", range.to);
  const suffix = qs.toString() ? `?${qs}` : "";
  const res = await fetch(`/api/projects/${projectId}/outcomes.csv${suffix}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) throw new Error(`Export failed: ${res.status}`);
  const blob = await res.blob();
  const url = window.URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${projectName.replace(/[^a-zA-Z0-9]/g, "_")}_outcomes.csv`;
  a.click();
  window.URL.revokeObjectURL(url);
}

// ─── Comparison reports ───────────────────────────────────────────

export interface ComparisonWindow {
  projectId: string;
  from?: string;  // YYYY-MM-DD
  to?: string;    // YYYY-MM-DD
}

export function compareReports(left: ComparisonWindow, right: ComparisonWindow) {
  return request<any>(`/projects/report/compare`, {
    method: "POST",
    body: JSON.stringify({ left, right }),
  });
}

export function explainComparisonResolution(payload: {
  left: ComparisonWindow;
  right: ComparisonWindow;
  issueText: string;
  issueSource: string;
  nodeLabel?: string;
  leftRunIds: string[];
  rightRunIds?: string[];
}) {
  return request<{ explanation: string; confidence: "high" | "medium" | "low"; costUsd: number }>(
    `/projects/report/compare/resolution`,
    { method: "POST", body: JSON.stringify(payload) }
  );
}

// ─── Users ────────────────────────────────────────────────────────

export function listUsers() {
  return request<any[]>("/users");
}

export function createUser(email: string, password: string, orgName?: string) {
  return request<any>("/users", {
    method: "POST",
    body: JSON.stringify({ email, password, ...(orgName ? { orgName } : {}) }),
  });
}

export function resetUserPassword(userId: string, password: string) {
  return request<any>(`/users/${userId}/password`, {
    method: "PATCH",
    body: JSON.stringify({ password }),
  });
}

export function deleteUser(userId: string) {
  return request<any>(`/users/${userId}`, { method: "DELETE" });
}

// ─── Tech Support ─────────────────────────────────────────────────

export type DocType = "DESCRIPTION" | "CODE_SNIPPET" | "ERROR_CODES" | "DATA_FLOW";
export type IssueType = "AGENT_BEHAVIOR" | "BACKEND_FAILURE" | "DATA_MISMATCH" | "VARIABLE_SETTER" | "CONFIGURATION" | "OTHER";
export type IssueStatus = "OPEN" | "IN_PROGRESS" | "RESOLVED" | "WONT_FIX";

export interface SystemDocument {
  id: string;
  projectId: string;
  name: string;
  docType: DocType;
  content: string;
  order: number;
  createdAt: string;
  updatedAt: string;
}

export interface TechIssueFix {
  id: string;
  issueId: string;
  description: string;
  nodeId: string | null;
  oldPrompt: string | null;
  newPrompt: string | null;
  appliedAt: string;
  appliedBy: string | null;
}

export interface TechIssue {
  id: string;
  projectId: string;
  title: string;
  issueType: IssueType;
  status: IssueStatus;
  description: string;
  rootCause: string | null;
  fix: string | null;
  component: string | null;
  fixes: TechIssueFix[];
  runs: Array<{
    id: string;
    runId: string;
    addedAt: string;
    run: { id: string; callDate: string | null; status: string; overallScore: number | null };
  }>;
  createdAt: string;
  updatedAt: string;
}

export interface TechSupportAnalysis {
  issueDetected: boolean;
  issueType: string | null;
  title: string | null;
  rootCause: string | null;
  suggestedFix: string | null;
  suggestedNodeId: string | null;
  suggestedNewPrompt: string | null;
  suggestedBugString: string | null;
  suggestedFixString: string | null;
  suggestedFieldType: "message" | "staticVariable" | null;
  fixWorked: boolean | "partial" | null;
  severity: "HIGH" | "MEDIUM" | "LOW" | null;
  matchesIssueId: string | null;
  confidence: number;
  variableComparison: Array<{
    variable: string;
    apiValue: any;
    extractedValue: any;
    match: boolean;
  }>;
  summary: string;
  costUsd: number;
}

// System docs
export function listSystemDocs(projectId: string) {
  return request<SystemDocument[]>(`/tech-support/${projectId}/system-docs`);
}
export function createSystemDoc(projectId: string, data: { name: string; docType: DocType; content: string; order?: number }) {
  return request<SystemDocument>(`/tech-support/${projectId}/system-docs`, { method: "POST", body: JSON.stringify(data) });
}
export function updateSystemDoc(projectId: string, docId: string, data: Partial<{ name: string; docType: DocType; content: string; order: number }>) {
  return request<{ ok: boolean }>(`/tech-support/${projectId}/system-docs/${docId}`, { method: "PATCH", body: JSON.stringify(data) });
}
export function deleteSystemDoc(projectId: string, docId: string) {
  return request<{ ok: boolean }>(`/tech-support/${projectId}/system-docs/${docId}`, { method: "DELETE" });
}

// Issues
export function listTechIssues(projectId: string) {
  return request<TechIssue[]>(`/tech-support/${projectId}/issues`);
}
export function createTechIssue(projectId: string, data: { title: string; issueType: IssueType; description: string; rootCause?: string; fix?: string; component?: string }) {
  return request<TechIssue>(`/tech-support/${projectId}/issues`, { method: "POST", body: JSON.stringify(data) });
}
export function updateTechIssue(projectId: string, issueId: string, data: Partial<{ title: string; issueType: IssueType; status: IssueStatus; description: string; rootCause: string; fix: string; component: string }>) {
  return request<{ ok: boolean }>(`/tech-support/${projectId}/issues/${issueId}`, { method: "PATCH", body: JSON.stringify(data) });
}
export function deleteTechIssue(projectId: string, issueId: string) {
  return request<{ ok: boolean }>(`/tech-support/${projectId}/issues/${issueId}`, { method: "DELETE" });
}
export function linkIssueToRun(projectId: string, issueId: string, runId: string) {
  return request<{ ok: boolean }>(`/tech-support/${projectId}/issues/${issueId}/link/${runId}`, { method: "POST" });
}
export function unlinkIssueFromRun(projectId: string, issueId: string, runId: string) {
  return request<{ ok: boolean }>(`/tech-support/${projectId}/issues/${issueId}/link/${runId}`, { method: "DELETE" });
}
export function applyIssueFix(projectId: string, issueId: string, data: {
  description: string;
  nodeId?: string;
  oldPrompt?: string;
  newPrompt?: string;
  bugString?: string;
  fixString?: string;
  fieldType?: "message" | "staticVariable";
}) {
  return request<{ ok: boolean; fix: TechIssueFix }>(`/tech-support/${projectId}/issues/${issueId}/apply-fix`, { method: "POST", body: JSON.stringify(data) });
}

// Human review gate
export function completeReview(runId: string, data: { note?: string; issueIds?: string[]; apiPayload?: any; skip?: boolean }) {
  return request<{ ok: boolean; runId: string }>(`/runs/${runId}/complete-review`, { method: "POST", body: JSON.stringify(data) });
}

// Push the suggested fix from a tech support analysis directly to the live agent
export function pushSuggestedFix(runId: string, data: {
  nodeId: string;
  bugString?: string;
  fixString?: string;
  fieldType?: "message" | "staticVariable";
  newPrompt?: string;
  description?: string;
  issueId?: string;
}) {
  return request<{ ok: boolean; nodeId: string; appliedNewPrompt: string }>(`/runs/${runId}/push-suggested-fix`, { method: "POST", body: JSON.stringify(data) });
}
