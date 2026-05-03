const API_BASE = "/api";

function getToken(): string | null {
  return localStorage.getItem("hamsa_eval_token");
}

// Guard against multiple simultaneous 401 responses all triggering a redirect.
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

export function getProject(id: string) {
  return request<any>(`/projects/${id}`);
}

export function createProject(data: {
  name: string;
  agentId: string;
  hamsaApiKey?: string;
  description?: string;
  agentStructure?: any;
  criteria?: any[];
  projectType?: "LIVE" | "HISTORY" | "WEBHOOK";
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

export function listRuns(projectId: string, skip = 0, take = 100) {
  return request<any[]>(`/runs/project/${projectId}?skip=${skip}&take=${take}`);
}

export function getRun(id: string) {
  return request<any>(`/runs/${id}`);
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

export async function importProjectBundle(file: File, preloadedText?: string): Promise<{ projectId: string; name: string; imported: number; warning?: string }> {
  const token = getToken();
  const text = preloadedText ?? await file.text();
  const res = await fetch("/api/projects/import-bundle", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: text,
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

export function reEvaluateFailedProject(projectId: string) {
  return request<{ ok: boolean; resetCount: number }>(`/projects/${projectId}/re-evaluate-failed`, { method: "POST" });
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

export function getProjectDashboard(projectId: string) {
  return request<any>(`/projects/${projectId}/dashboard`);
}

export function getRunsByIds(projectId: string, ids: string[]) {
  return request<any[]>(`/projects/${projectId}/runs-by-ids?ids=${ids.join(",")}`);
}

export function getProjectReport(projectId: string, weeks = 7) {
  return request<any>(`/projects/${projectId}/report?weeks=${weeks}`);
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
