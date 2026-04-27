import dotenv from "dotenv";
dotenv.config();

const HAMSA_API_BASE =
  process.env.HAMSA_API_BASE || "https://api.tryhamsa.com";
const DEFAULT_API_KEY = process.env.HAMSA_API_KEY || "";

function headers(apiKey?: string): Record<string, string> {
  const key = apiKey || DEFAULT_API_KEY;
  if (!key) throw new Error("Hamsa API key is required but not configured");
  return {
    "Content-Type": "application/json",
    Authorization: `Token ${key}`,
  };
}

/** Fetch with an AbortController timeout. Default 30s. */
async function fetchWithTimeout(
  url: string,
  options: RequestInit & { timeoutMs?: number } = {}
): Promise<Response> {
  const { timeoutMs = 30_000, ...fetchOptions } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...fetchOptions, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Update the LLM model on a Hamsa voice agent.
 * Docs: https://docs.tryhamsa.com/api-reference/endpoint/update-voice-agent-v2
 */
export async function updateAgentModel(
  agentId: string,
  model: string,
  provider?: string,
  apiKey?: string
) {
  const url = `${HAMSA_API_BASE}/v2/voice-agents/${agentId}`;

  // Parse provider from model string if not given (e.g. "openai/gpt-4o" -> provider=OpenAI, model=gpt-4o)
  // Hamsa expects exact casing: OpenAI, Gemini, deepmyst, Custom, Groq
  const PROVIDER_MAP: Record<string, string> = {
    openai: "OpenAI",
    gemini: "Gemini",
    deepmyst: "deepmyst",
    custom: "Custom",
    groq: "Groq",
  };

  // Hamsa model name map — keyed by lowercase provider+model slug, value is Hamsa's expected name
  const MODEL_MAP: Record<string, string> = {
    // OpenAI
    "openai/gpt-5": "GPT-5",
    "openai/gpt-5-mini": "GPT-5-Mini",
    "openai/gpt-5-nano": "GPT-5-Nano",
    "openai/gpt-4.1": "GPT-4.1",
    "openai/gpt-4.1-mini": "GPT-4.1-Mini",
    "openai/gpt-4.1-nano": "GPT-4.1-Nano",
    "openai/gpt-4o": "GPT-4o",
    "openai/gpt-4o-mini": "GPT-4o-mini",
    // Groq (local model-only keys for when provider is already known to be Groq)
    "groq/gpt-120-oss": "openai/gpt-oss-120b",
    "groq/gpt-20-oss": "openai/gpt-oss-20b",
  };

  let llmProvider = provider;
  let llmModel = model;

  if (model.includes("/")) {
    const slashIdx = model.indexOf("/");
    const providerSlug = model.slice(0, slashIdx).toLowerCase();
    const modelSlug = model.slice(slashIdx + 1);
    const fullKey = `${providerSlug}/${modelSlug}`.toLowerCase();

    // Look up by full key first for provider-specific model name overrides
    if (MODEL_MAP[fullKey]) {
      llmModel = MODEL_MAP[fullKey];
      llmProvider = provider || PROVIDER_MAP[providerSlug] || providerSlug;
    } else {
      llmProvider = provider || PROVIDER_MAP[providerSlug] || providerSlug;
      llmModel = modelSlug;
    }
  } else if (llmProvider) {
    llmProvider = PROVIDER_MAP[llmProvider.toLowerCase()] || llmProvider;
  }

  const body: Record<string, unknown> = {
    llm: {
      provider: llmProvider,
      model: llmModel,
      temperature: 0.2,
    },
  };

  const res = await fetchWithTimeout(url, {
    method: "PATCH",
    headers: headers(apiKey),
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to update agent model: ${res.status} — ${text}`);
  }

  return res.json();
}

/**
 * Fetch the call log for a completed call.
 * Endpoint: GET /v1/agent-analytics/logs?jobId={callId}
 */
export async function fetchCallLog(callId: string, apiKey?: string, baseUrl?: string) {
  const base = baseUrl || HAMSA_API_BASE;
  const url = `${base}/v1/agent-analytics/logs?jobId=${callId}`;

  console.log(`[HamsaAPI] Fetching call log: ${url}`);

  const res = await fetchWithTimeout(url, {
    method: "GET",
    headers: headers(apiKey),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to fetch call log: ${res.status} — ${text}`);
  }

  const json = await res.json() as any;
  // Response is { success: true, data: [...logs] } — return the data array
  return ("data" in json) ? json.data : json;
}

/**
 * Get agent details (v2).
 * Returns full agent config: name, type, conversation.preamble (instructions),
 * workflow (flow agent node graph), tools, llm config, voice settings, etc.
 */
export async function getAgent(agentId: string, apiKey?: string) {
  const url = `${HAMSA_API_BASE}/v2/voice-agents/${agentId}`;

  const res = await fetchWithTimeout(url, {
    method: "GET",
    headers: headers(apiKey),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to get agent: ${res.status} — ${text}`);
  }

  const json = await res.json() as any;
  return ("data" in json) ? json.data : json;
}

/**
 * Fetch a single conversation/call by its conversationId.
 * Returns transcript, logs, call duration, media URL, and agent config at time of call.
 * Endpoint: GET /v1/voice-agents/conversation/{conversationId}
 */
export async function fetchConversation(conversationId: string, apiKey?: string, baseUrl?: string) {
  const base = baseUrl || HAMSA_API_BASE;
  const url = `${base}/v1/voice-agents/conversation/${conversationId}`;

  console.log(`[HamsaAPI] Fetching conversation: ${conversationId}`);

  const res = await fetchWithTimeout(url, {
    method: "GET",
    headers: headers(apiKey),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to fetch conversation ${conversationId}: ${res.status} — ${text}`);
  }

  const json = await res.json() as any;
  return ("data" in json) ? json.data : json;
}

/**
 * Export conversations for an agent as an Excel binary buffer.
 * Endpoint: GET /v1/agent-analytics/conversations/export
 *
 * period: LAST_HOUR | TODAY | YESTERDAY | THIS_WEEK | THIS_MONTH | CUSTOM
 * startPeriod / endPeriod: millisecond timestamps (required when period=CUSTOM)
 */
export async function exportConversations(
  agentId: string,
  options: {
    period?: string;
    startPeriod?: number;
    endPeriod?: number;
    status?: string;
    timeDifference?: string;
  } = {},
  apiKey?: string
): Promise<Buffer> {
  const params = new URLSearchParams({
    voiceAgentId: agentId,
    period: options.period || "THIS_MONTH",
    timeDifference: options.timeDifference || "0",
  });
  if (options.status) params.set("status", options.status);
  // Use != null so that 0 (epoch) is not dropped
  if (options.startPeriod != null) params.set("startPeriod", String(options.startPeriod));
  if (options.endPeriod != null) params.set("endPeriod", String(options.endPeriod));

  const url = `${HAMSA_API_BASE}/v1/agent-analytics/conversations/export?${params}`;

  const fs = require("fs");
  const path = require("path");
  const logFile = path.join(__dirname, "../../import.log");
  const flog = (msg: string) => { console.log(msg); fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${msg}\n`); };

  flog(`[HamsaAPI] Export URL: ${url}`);

  const key = apiKey || DEFAULT_API_KEY;
  if (!key) throw new Error("Hamsa API key is required but not configured");

  const t0 = Date.now();
  const res = await fetchWithTimeout(url, {
    method: "GET",
    headers: { Authorization: `Token ${key}` },
    timeoutMs: 120_000,
  });
  flog(`[HamsaAPI] Export response: ${res.status} in ${Date.now() - t0}ms, content-type: ${res.headers.get("content-type")}`);

  if (!res.ok) {
    const text = await res.text();
    // Hamsa sometimes returns a Cloudflare HTML error page (504, 502) — strip the HTML
    const isHtml = text.trimStart().startsWith("<!") || text.trimStart().startsWith("<html");
    if (isHtml) {
      if (res.status === 504) throw new Error(`Hamsa's export server timed out (504). Their infrastructure may be under load — please try again in a minute.`);
      if (res.status === 502) throw new Error(`Hamsa's export server is temporarily unavailable (502). Please try again in a minute.`);
      throw new Error(`Hamsa returned HTTP ${res.status}. Please try again.`);
    }
    throw new Error(`Failed to export conversations: ${res.status} — ${text}`);
  }

  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

// ─── Async CSV Export (new dev API) ──────────────────────────────────

/**
 * Request an async conversation export (CSV) from Hamsa's analytics API.
 * Returns an exportId that can be polled for status.
 *
 * Endpoint: GET /v1/agent-analytics/conversations/export
 * (with projectId param instead of voiceAgentId — the new pattern)
 */
export async function requestConversationExport(
  projectId: string,
  voiceAgentId: string,
  options: {
    startPeriod: number;
    endPeriod: number;
  },
  apiKey?: string,
  baseUrl?: string,
): Promise<string> {
  const base = baseUrl || HAMSA_API_BASE;
  const params = new URLSearchParams({
    projectId,
    voiceAgentId,
    period: "CUSTOM",
    startPeriod: String(options.startPeriod),
    endPeriod: String(options.endPeriod),
  });

  const url = `${base}/v1/agent-analytics/conversations/export?${params}`;
  console.log(`[HamsaAPI] Requesting async export: ${url}`);

  const res = await fetchWithTimeout(url, {
    method: "GET",
    headers: headers(apiKey),
    timeoutMs: 30_000,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to request export: ${res.status} — ${text}`);
  }

  const json = await res.json() as any;
  if (!json.success || !json.data?.exportId) {
    throw new Error(`Export request failed: ${json.message || "no exportId returned"}`);
  }

  return json.data.exportId;
}

/**
 * Poll the export status until ready, failed, or expired.
 * Returns the download URL when ready.
 */
export async function pollExportStatus(
  projectId: string,
  exportId: string,
  apiKey?: string,
  baseUrl?: string,
): Promise<string> {
  const base = baseUrl || HAMSA_API_BASE;
  const params = new URLSearchParams({ projectId, exportId });
  const url = `${base}/v1/agent-analytics/conversations/export/status?${params}`;

  const MAX_POLLS = 60; // 5 minutes max (5s intervals)
  let consecutiveErrors = 0;
  const MAX_CONSECUTIVE_ERRORS = 3;

  for (let i = 0; i < MAX_POLLS; i++) {
    try {
      const res = await fetchWithTimeout(url, {
        method: "GET",
        headers: headers(apiKey),
        timeoutMs: 15_000,
      });

      if (!res.ok) {
        const text = await res.text();
        // Treat 5xx as transient — retry
        if (res.status >= 500) {
          consecutiveErrors++;
          console.warn(`[HamsaAPI] Export status poll got ${res.status}, retrying (${consecutiveErrors}/${MAX_CONSECUTIVE_ERRORS})`);
          if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
            throw new Error(`Export status check failed after ${MAX_CONSECUTIVE_ERRORS} retries: ${res.status} — ${text}`);
          }
          await new Promise((resolve) => setTimeout(resolve, 5000));
          continue;
        }
        throw new Error(`Export status check failed: ${res.status} — ${text}`);
      }

      consecutiveErrors = 0; // reset on success
      const json = await res.json() as any;
      const { status, downloadUrl, error } = json.data || {};

      if (status === "ready" && downloadUrl) {
        console.log(`[HamsaAPI] Export ready after ${i + 1} polls`);
        return downloadUrl;
      }
      if (status === "failed") {
        throw new Error(`Export failed: ${error || "unknown error"}`);
      }
      if (status === "expired") {
        throw new Error("Export job expired");
      }
    } catch (err) {
      // Network errors (timeout, DNS, etc.) — retry unless too many
      if ((err as Error).message.includes("Export failed") || (err as Error).message.includes("expired")) {
        throw err; // terminal errors — don't retry
      }
      consecutiveErrors++;
      console.warn(`[HamsaAPI] Export status poll error: ${(err as Error).message} (${consecutiveErrors}/${MAX_CONSECUTIVE_ERRORS})`);
      if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) throw err;
    }

    // Wait 5 seconds before next poll
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }

  throw new Error("Export timed out after 5 minutes of polling");
}

/**
 * Download a CSV from a URL and parse conversation IDs from the "ID" column.
 * Returns array of conversation UUIDs.
 */
export async function downloadAndParseExportCsv(downloadUrl: string): Promise<string[]> {
  const res = await fetchWithTimeout(downloadUrl, { timeoutMs: 60_000 });
  if (!res.ok) {
    throw new Error(`Failed to download export CSV: ${res.status}`);
  }

  const text = await res.text();
  // Normalize line endings (handle \r\n from Windows/CloudFront)
  const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n").filter((l) => l.trim());
  if (lines.length < 2) return []; // header only or empty

  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  // Parse CSV header to find the ID column
  const headerLine = lines[0];
  const csvHeaders = parseCsvLine(headerLine);
  const idColIndex = csvHeaders.findIndex((h) => h.trim().toUpperCase() === "ID");

  if (idColIndex === -1) {
    // Fallback: find any column with UUIDs
    const ids: string[] = [];
    for (let i = 1; i < lines.length; i++) {
      const cols = parseCsvLine(lines[i]);
      for (const col of cols) {
        const v = col.trim();
        if (UUID_RE.test(v)) { ids.push(v); break; }
      }
    }
    return ids;
  }

  // Extract IDs from the identified column, validate UUID format
  const ids: string[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = parseCsvLine(lines[i]);
    const val = cols[idColIndex]?.trim();
    if (val && UUID_RE.test(val)) ids.push(val);
  }
  return ids;
}

/** Simple CSV line parser that handles quoted fields with commas and escaped quotes */
function parseCsvLine(line: string): string[] {
  const cleaned = line.replace(/\r$/, ""); // strip trailing carriage return
  const result: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (ch === '"') {
      // Handle escaped quotes ("") inside quoted fields
      if (inQuotes && cleaned[i + 1] === '"') {
        current += '"';
        i++; // skip the second quote
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === "," && !inQuotes) {
      result.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  result.push(current);
  return result;
}

/**
 * Extract transcript from a conversation object returned by fetchConversation().
 * Tries multiple locations in the response to find the transcription array.
 * Returns array of {Agent: string} | {User: string} objects (same format as webhook).
 */
export function extractTranscriptFromConversation(conv: any): Array<Record<string, string>> | null {
  if (!conv) return null;

  // Helper: test if a value looks like a transcript array (has Agent or User keys)
  function isTranscript(v: unknown): v is Array<Record<string, string>> {
    return Array.isArray(v) && v.length > 0 &&
      typeof v[0] === "object" && v[0] !== null &&
      ("Agent" in v[0] || "User" in v[0] || "agent" in v[0] || "user" in v[0]);
  }

  // 1. jobResponse.transcription — PRIMARY location in Hamsa v1 conversation API
  if (isTranscript(conv.jobResponse?.transcription)) return conv.jobResponse.transcription;

  // 2. callAnalysis (may contain transcription on some call types)
  if (isTranscript(conv.callAnalysis?.transcription)) return conv.callAnalysis.transcription;
  if (isTranscript(conv.callAnalysis?.conversation))  return conv.callAnalysis.conversation;
  if (isTranscript(conv.callAnalysis?.transcript))    return conv.callAnalysis.transcript;

  // 3. Top-level fields (some endpoints return these directly)
  if (isTranscript(conv.transcription)) return conv.transcription;
  if (isTranscript(conv.conversation))  return conv.conversation;
  if (isTranscript(conv.transcript))    return conv.transcript;
  if (isTranscript(conv.messages))      return conv.messages;

  // 3. Nested under data (in case the envelope wasn't fully unwrapped)
  if (isTranscript(conv.data?.callAnalysis?.transcription)) return conv.data.callAnalysis.transcription;
  if (isTranscript(conv.data?.transcription))               return conv.data.transcription;
  if (isTranscript(conv.data?.conversation))                return conv.data.conversation;

  // 4. callData sub-object
  if (isTranscript(conv.callData?.transcription)) return conv.callData.transcription;
  if (isTranscript(conv.callData?.conversation))  return conv.callData.conversation;

  // 5. Scan logs[] payloads
  if (Array.isArray(conv.logs)) {
    for (const log of conv.logs) {
      const p = log?.payload;
      if (isTranscript(p?.transcription)) return p.transcription;
      if (isTranscript(p?.transcript))    return p.transcript;
      if (isTranscript(p?.conversation))  return p.conversation;
    }
  }

  // 6. Last resort: any top-level array value that looks like a transcript
  for (const val of Object.values(conv)) {
    if (isTranscript(val)) return val as Array<Record<string, string>>;
  }

  return null;
}

/**
 * Extract the job ID from a conversation object.
 * This is used to fetch execution logs via /v1/agent-analytics/logs?jobId=...
 * Returns null if no job ID is found — callers should NOT fall back to conversationId.
 */
export function extractJobIdFromConversation(conv: any): string | null {
  if (!conv) return null;
  // jobResponse contains call metadata (transcription, outcomeResult, timestamps)
  // but NOT a jobId for the analytics logs endpoint.
  // The execution logs are already embedded in conv.logs — use those directly.
  return (
    conv?.jobId ||
    conv?.jobResponse?.jobId ||
    conv?.jobResponse?.id ||
    null
  );
}

/**
 * Extract a transcript from Hamsa execution logs (the callLog array returned by fetchCallLog).
 *
 * Hamsa execution logs contain CONVERSATION category events. Two patterns observed:
 *   Pattern A (role-based):  { category: "CONVERSATION", payload: { role: "agent"|"user", message: "..." } }
 *   Pattern B (message-key): { category: "CONVERSATION", message: "Playing message...", payload: { message: "..." } }
 *   Pattern C (transcription object): one event with payload.transcription being a transcript array
 *
 * Returns null if no usable conversation turns are found.
 */
export function extractTranscriptFromCallLog(callLog: any[]): Array<Record<string, string>> | null {
  if (!Array.isArray(callLog) || callLog.length === 0) return null;

  // Pattern C: one event in the log has a full transcription array in its payload
  for (const entry of callLog) {
    const p = entry?.payload;
    if (Array.isArray(p?.transcription) && p.transcription.length > 0) {
      const t = p.transcription;
      if (typeof t[0] === "object" && ("Agent" in t[0] || "User" in t[0] || "agent" in t[0] || "user" in t[0])) {
        return t;
      }
    }
    if (Array.isArray(p?.transcript) && p.transcript.length > 0) {
      const t = p.transcript;
      if (typeof t[0] === "object" && ("Agent" in t[0] || "User" in t[0] || "agent" in t[0] || "user" in t[0])) {
        return t;
      }
    }
    if (Array.isArray(p?.conversation) && p.conversation.length > 0) {
      const t = p.conversation;
      if (typeof t[0] === "object" && ("Agent" in t[0] || "User" in t[0] || "agent" in t[0] || "user" in t[0])) {
        return t;
      }
    }
  }

  // Pattern A: role-based conversation entries — rebuild transcript from sequential events
  const conversationEvents = callLog.filter(
    (e: any) => e?.category === "CONVERSATION" && e?.payload?.role && e?.payload?.message
  );
  if (conversationEvents.length > 0) {
    return conversationEvents.map((e: any): Record<string, string> => {
      const role = String(e.payload.role ?? "").toLowerCase();
      const text = String(e.payload.message ?? "");
      if (role === "user") return { User: text };
      return { Agent: text };
    });
  }

  // Pattern B: extract agent prompts from "Playing message" events + user turns from STT events
  const turns: Array<Record<string, string>> = [];
  for (const e of callLog) {
    if (e?.category !== "CONVERSATION") continue;
    const p = e?.payload ?? {};
    const msg = p.message ?? p.text ?? p.content ?? p.transcript ?? "";
    if (!msg) continue;

    const msgLower = String(e.message ?? "").toLowerCase();
    // "Playing message" events are agent turns
    if (msgLower.includes("playing message") || msgLower.includes("agent said") || msgLower.includes("agent response")) {
      turns.push({ Agent: String(msg) });
    // STT/ASR recognition events are user turns
    } else if (msgLower.includes("user said") || msgLower.includes("user input") || msgLower.includes("recognition") || msgLower.includes("stt")) {
      turns.push({ User: String(msg) });
    }
  }

  return turns.length > 0 ? turns : null;
}
