import dotenv from "dotenv";
dotenv.config();

const HAMSA_API_BASE =
  process.env.HAMSA_API_BASE || "https://api.tryhamsa.com";
const DEFAULT_API_KEY = process.env.HAMSA_API_KEY || "";

function headers(apiKey?: string) {
  return {
    "Content-Type": "application/json",
    Authorization: `Token ${apiKey || DEFAULT_API_KEY}`,
  };
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

  // Hamsa expects exact model names: GPT-5, GPT-5-Mini, GPT-5-Nano, GPT-4.1, GPT-4.1-Mini, GPT-4.1-Nano, GPT-4o, GPT-4o-mini
  const MODEL_MAP: Record<string, string> = {
    "gpt-5": "GPT-5",
    "gpt-5-mini": "GPT-5-Mini",
    "gpt-5-nano": "GPT-5-Nano",
    "gpt-4.1": "GPT-4.1",
    "gpt-4.1-mini": "GPT-4.1-Mini",
    "gpt-4.1-nano": "GPT-4.1-Nano",
    "gpt-4o": "GPT-4o",
    "gpt-4o-mini": "GPT-4o-mini",
    "gpt-120-oss": "openai/gpt-oss-120b",
    "gpt-20-oss": "openai/gpt-oss-20b",
  };

  let llmProvider = provider;
  let llmModel = model;
  if (!provider && model.includes("/")) {
    const [p, m] = model.split("/", 2);
    llmProvider = PROVIDER_MAP[p.toLowerCase()] || p;
    llmModel = MODEL_MAP[m.toLowerCase()] || m;
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
 * Docs: https://docs.tryhamsa.com/api-reference/endpoint/get-call-log
 * Endpoint: GET /v1/agent-analytics/logs/{callId}
 */
export async function fetchCallLog(callId: string, apiKey?: string) {
  const url = `${HAMSA_API_BASE}/v1/agent-analytics/logs/${callId}`;

  console.log(`[HamsaAPI] Fetching call log: ${url}`);

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
