import dotenv from "dotenv";
dotenv.config();

const HAMSA_API_BASE =
  process.env.HAMSA_API_BASE || "https://api.tryhamsa.ai";
const DEFAULT_API_KEY = process.env.HAMSA_API_KEY || "";

function headers(apiKey?: string) {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey || DEFAULT_API_KEY}`,
  };
}

/**
 * Update the LLM model on a Hamsa voice agent.
 * Uses: PATCH /v2/voice-agents/{agentId}
 */
export async function updateAgentModel(
  agentId: string,
  model: string,
  provider?: string,
  apiKey?: string
) {
  const url = `${HAMSA_API_BASE}/v2/voice-agents/${agentId}`;

  // Parse provider from model string if not given (e.g. "openai/gpt-4o" -> provider=OpenAI, model=gpt-4o)
  let llmProvider = provider;
  let llmModel = model;
  if (!provider && model.includes("/")) {
    const [p, m] = model.split("/", 2);
    llmProvider = p;
    llmModel = m;
  }

  const body: Record<string, unknown> = {
    llm: {
      provider: llmProvider,
      model: llmModel,
    },
  };

  const res = await fetch(url, {
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
 * Uses: GET /calls/{callId}/log
 */
export async function fetchCallLog(callId: string, apiKey?: string) {
  const url = `${HAMSA_API_BASE}/calls/${callId}/log`;

  const res = await fetch(url, {
    method: "GET",
    headers: headers(apiKey),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to fetch call log: ${res.status} — ${text}`);
  }

  return res.json();
}

/**
 * Get agent details.
 * Uses: GET /v2/voice-agents/{agentId}
 */
export async function getAgent(agentId: string, apiKey?: string) {
  const url = `${HAMSA_API_BASE}/v2/voice-agents/${agentId}`;

  const res = await fetch(url, {
    method: "GET",
    headers: headers(apiKey),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to get agent: ${res.status} — ${text}`);
  }

  return res.json();
}
