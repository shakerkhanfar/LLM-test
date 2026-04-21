import OpenAI from "openai";
import dotenv from "dotenv";
dotenv.config();

/**
 * Analyze an agent's structure (fetched from Hamsa) and produce a plain-text summary
 * that describes its purpose, expected conversation flow, and success criteria.
 * This summary is stored on the project and injected into every evaluation prompt.
 */
export async function generateAgentSummary(agentStructure: any): Promise<string> {
  if (!agentStructure) return "";
  // Skip generation if there's no substantive data — preamble or nodes must exist
  const hasContent =
    agentStructure.conversation?.preamble ||
    agentStructure.workflow?.nodes?.length > 0 ||
    agentStructure.tools?.length > 0;
  if (!hasContent) {
    console.warn("[AgentSummary] Agent structure has no preamble, nodes, or tools — skipping summary");
    return "";
  }

  const nodes: any[] = agentStructure.workflow?.nodes ?? [];
  const edges: any[] = agentStructure.workflow?.edges ?? [];
  const tools: any[] = agentStructure.tools ?? [];
  const preamble: string = agentStructure.conversation?.preamble ?? "";
  const greeting: string = agentStructure.conversation?.greetingMessage ?? "";
  const lang: string = agentStructure.voice?.lang ?? "unknown";
  const llmModel: string = agentStructure.llm?.model ?? "unknown";

  // Build a compact representation of the flow for the LLM
  const nodeLines = nodes.map((n: any) => {
    const outEdges = edges.filter((e: any) => e.source === n.id);
    const targets = outEdges.map((e: any) => {
      const t = nodes.find((nd: any) => nd.id === e.target);
      return t?.label ?? e.target;
    });
    const vars = n.extractVariables?.variables?.map((v: any) => v.name).join(", ") ?? "";
    return [
      `  - Node: "${n.label}" (type: ${n.type})`,
      n.message ? `    Prompt: ${n.message.slice(0, 200)}` : "",
      vars ? `    Extracts: ${vars}` : "",
      targets.length ? `    → Next: ${targets.join(", ")}` : "",
    ].filter(Boolean).join("\n");
  }).join("\n");

  const toolLines = tools.map((t: any) =>
    `  - ${t.name ?? t.id}: ${t.description ?? ""}`.trim()
  ).join("\n");

  const prompt = `You are analyzing the structure of a voice AI agent built on Hamsa.

AGENT NAME: ${agentStructure.name}
TYPE: ${agentStructure.type}
LANGUAGE: ${lang}
LLM: ${llmModel}

GREETING:
${greeting}

INSTRUCTIONS / PREAMBLE:
${preamble}

FLOW NODES:
${nodeLines || "(no flow nodes defined)"}

TOOLS AVAILABLE:
${toolLines || "(no tools)"}

Based on the above, write a structured plain-text analysis that will be given to an LLM evaluator before it scores a call. Be specific and concise. Format exactly as:

AGENT PURPOSE:
[1-3 sentences: what this agent is designed to do, for whom, and in what language]

EXPECTED CALL FLOW:
[Numbered list of stages the call should go through, including what the agent collects or does at each stage]

SUCCESS CRITERIA:
[Bullet list of what a successful call looks like — what must happen, what must not happen]

COMMON FAILURE MODES:
[Bullet list of things that would indicate a bad call — wrong language, missing data, stuck transitions, tool errors, etc.]

VARIABLES THAT MUST BE COLLECTED:
[Comma-separated list of variable names the agent is expected to extract during the call]`;

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4.1-mini",
      messages: [{ role: "user", content: prompt }],
      temperature: 0,
      max_tokens: 800,
    });
    return response.choices[0]?.message?.content?.trim() ?? "";
  } catch (err) {
    console.warn("[AgentSummary] Failed to generate agent summary:", (err as Error).message);
    return "";
  }
}

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Cost per million tokens (USD) — update if pricing changes
const MODEL_COSTS: Record<string, { input: number; output: number }> = {
  "gpt-4.1":      { input: 2.00, output: 8.00 },
  "gpt-4.1-mini": { input: 0.40, output: 1.60 },
};

function calcCost(model: string, promptTokens: number, completionTokens: number): number {
  const rates = MODEL_COSTS[model];
  if (!rates) {
    console.warn(`[LLMJudge] Unknown model "${model}" — cost not tracked`);
    return 0;
  }
  return (promptTokens / 1_000_000) * rates.input + (completionTokens / 1_000_000) * rates.output;
}

/**
 * LLM judge for transcript-based criteria.
 * Returns null scores when the criterion doesn't apply.
 */
export async function evaluateWithLLMJudge(
  rule: string,
  transcriptText: string,
  /** Set true when `rule` is already the complete LLM prompt (FLOW_PROGRESSION, ACTION_CONSISTENCY) */
  isFullPrompt = false,
  /** Override model — use "gpt-4.1" for nuanced Arabic morphology checks */
  modelOverride?: string
): Promise<{ passed: boolean | null; score: number | null; detail: string; costUsd: number }> {

  const prompt = isFullPrompt
    ? rule
    : `You are evaluating a voice AI agent transcript for an Arabic-first voice AI platform.

PLATFORM CONTEXT (read this before evaluating):

TRANSCRIPT FORMAT — understand who is speaking before evaluating:
- Lines starting with [Agent]: are spoken by the AI voice assistant.
- Lines starting with [User] or [User (gender: male/female)]: are spoken by the human customer.
- The gender tag on [User] lines is the detected gender of the CUSTOMER, not the agent.

GENDER DETECTION — this is the most nuanced criterion, read carefully:
The agent is a FEMALE AI assistant by design. This means:
  (A) The agent referring to HERSELF in feminine forms is ALWAYS correct.
      e.g., "مختصره", "أنا متاحه", "شكراً لك" — these are the agent describing herself. NOT errors.
  (B) The USER speaking to the AGENT (addressing a female agent with feminine forms) is NEVER evaluated.
      The user's speech is irrelevant to this criterion. IGNORE all [User] lines entirely.
  (C) The ONLY thing being evaluated: does the AGENT use the correct gender forms when directly
      addressing or referring to the CUSTOMER (the human on the call)?
      - If the customer is [User (gender: male)]: agent must use masculine forms when speaking TO the customer
        (e.g., "تفضل", "عندك", "ممكن تساعدني" for male customer = CORRECT)
      - If the customer is [User (gender: female)]: agent must use feminine forms when speaking TO the customer
        (e.g., "تفضلي", "عندك", "ممكن تساعديني" for female customer = CORRECT)
  A gender error is ONLY when the agent uses a form meant for the OPPOSITE gender of the customer
  when the agent is directly addressing or referring to the customer in that turn.
  If no customer gender is detected or it's ambiguous, return not-applicable.

LANGUAGE SWITCHING — there are exactly two failure scenarios:
    (A) The user explicitly asked to switch languages but the agent did not switch (or delayed noticeably).
    (B) The agent switched back to Arabic (or another language) after the user already requested a different language, without the user asking for that.
  Anything else is a pass: agent starting in Arabic, agent staying in the requested language throughout the call, agent complying immediately when asked.

Evaluation rule: "${rule}"

Transcript:
${transcriptText}

RULES YOU MUST FOLLOW:

1. NOT APPLICABLE: If this criterion did not occur in the conversation at all (e.g. no language switch happened, gender was never relevant), return:
   { "passed": null, "score": null, "detail": "Not applicable — [reason]" }

2. EVIDENCE REQUIRED: Your "detail" field MUST quote the exact word(s) or phrase(s) from the transcript above that support your verdict. Do NOT cite words or phrases that do not appear verbatim in the transcript. If you cannot find direct evidence, say so.

3. COMMIT TO A VERDICT FIRST, THEN WRITE DETAIL: Decide passed=true/false, then write one or two sentences that explain why. Do NOT write a reasoning chain that walks through possibilities — state only the final conclusion. Do NOT write corrections or second-guesses in the detail field.

4. CONSISTENCY: Your "passed" and "score" MUST match your "detail". If the agent behaved correctly → passed=true, score near 1.0. If the agent made a clear error → passed=false, score near 0. Never contradict yourself across the three fields.

Respond with JSON only — no text outside the JSON:
{
  "passed": true | false | null,
  "score": 0.0 to 1.0 | null,
  "detail": "One or two sentence verdict with quoted evidence from transcript"
}`;

  // Use gpt-4.1 for full flow analysis or nuanced Arabic checks; gpt-4.1-mini for simple checks
  const model = modelOverride ?? (isFullPrompt ? "gpt-4.1" : "gpt-4.1-mini");

  const response = await openai.chat.completions.create({
    model,
    messages: [{ role: "user", content: prompt }],
    response_format: { type: "json_object" },
    temperature: 0,
  });

  const usage = response.usage;
  const costUsd = usage
    ? calcCost(model, usage.prompt_tokens, usage.completion_tokens)
    : 0;

  const content = response.choices[0]?.message?.content;
  if (!content) {
    return { passed: null, score: null, detail: "LLM judge returned empty response", costUsd };
  }

  try {
    const result = JSON.parse(content);

    // For full-prompt callers (FLOW_PROGRESSION, ACTION_CONSISTENCY), return
    // the raw JSON as detail so they can parse the full structured response.
    if (isFullPrompt) {
      return {
        passed: result.passed === null ? null : Boolean(result.passed),
        score: result.score === null ? null : (Number(result.score) || 0),
        detail: content,
        costUsd,
      };
    }

    let passed = result.passed === null ? null : Boolean(result.passed);
    let score = result.score === null ? null : (Number(result.score) || 0);
    const detail = String(result.detail || "");

    // Consistency guard: if the JSON verdict contradicts the detail text, correct the verdict.
    // The model sometimes reasons correctly but then produces the wrong JSON fields.
    // We trust the detail's conclusion over the raw JSON when signals are unambiguous.
    if (passed === false && detail) {
      const lower = detail.toLowerCase();
      const positiveSignals = [
        "passed should be true", "correction: passed=true", "hence, passed",
        "should pass", "is correct", "no error", "no violation",
        "correctly performed", "complied", "performed correctly",
        "did not violate", "agent correctly",
      ];
      if (positiveSignals.some((s) => lower.includes(s))) {
        console.warn(
          `[LLMJudge] Consistency mismatch — correcting passed=false→true based on detail. Detail: "${detail.slice(0, 120)}"`
        );
        passed = true;
        score = score !== null && score < 0.5 ? 1.0 : score; // also fix a clearly wrong score
      }
    }
    if (passed === true && detail) {
      const lower = detail.toLowerCase();
      const negativeSignals = [
        "passed should be false", "correction: passed=false",
        "agent failed", "agent did not", "agent never", "agent refused",
        "violated the rule", "did not comply",
      ];
      if (negativeSignals.some((s) => lower.includes(s))) {
        console.warn(
          `[LLMJudge] Consistency mismatch — correcting passed=true→false based on detail. Detail: "${detail.slice(0, 120)}"`
        );
        passed = false;
        score = score !== null && score > 0.5 ? 0.0 : score;
      }
    }

    return { passed, score, detail, costUsd };
  } catch {
    return { passed: null, score: null, detail: `Failed to parse LLM response: ${content}`, costUsd };
  }
}
