const API_BASE = import.meta.env.DEV ? "http://localhost:3001/api" : "/api";

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API error ${res.status}: ${text}`);
  }
  return res.json();
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
}) {
  return request<any>("/projects", {
    method: "POST",
    body: JSON.stringify(data),
  });
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

export function listRuns(projectId: string) {
  return request<any[]>(`/runs/project/${projectId}`);
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
