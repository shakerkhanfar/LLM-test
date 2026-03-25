import OpenAI from "openai";
import dotenv from "dotenv";
dotenv.config();

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/**
 * LLM judge for transcript-based criteria.
 * Returns null scores when the criterion doesn't apply.
 */
export async function evaluateWithLLMJudge(
  rule: string,
  transcriptText: string
): Promise<{ passed: boolean | null; score: number | null; detail: string }> {
  // If transcriptText is empty, the rule IS the full prompt (used by FLOW_PROGRESSION)
  const isFullPrompt = !transcriptText;

  const prompt = isFullPrompt
    ? rule
    : `You are evaluating a voice AI agent transcript for an Arabic-first voice AI platform.

Evaluation rule: "${rule}"

Transcript:
${transcriptText}

IMPORTANT: If this criterion is NOT APPLICABLE to this conversation (e.g. evaluating "language switching" but no language switch was requested, or evaluating "gender detection" but gender was not relevant), you MUST return:
{ "passed": null, "score": null, "detail": "Not applicable — [reason]" }

Only evaluate if the criterion actually applies to what happened in the conversation.

Respond with JSON only:
{
  "passed": true | false | null,
  "score": 0.0 to 1.0 | null,
  "detail": "one sentence explanation in English"
}`;

  // Use gpt-4.1 for full flow analysis (complex), gpt-4.1-mini for simple checks
  const model = isFullPrompt ? "gpt-4.1" : "gpt-4.1-mini";

  const response = await openai.chat.completions.create({
    model,
    messages: [{ role: "user", content: prompt }],
    response_format: { type: "json_object" },
    temperature: 0,
  });

  const content = response.choices[0]?.message?.content;
  if (!content) {
    return { passed: null, score: null, detail: "LLM judge returned empty response" };
  }

  try {
    const result = JSON.parse(content);
    return {
      passed: result.passed === null ? null : Boolean(result.passed),
      score: result.score === null ? null : Number(result.score) || 0,
      detail: String(result.detail || ""),
    };
  } catch {
    return { passed: null, score: null, detail: `Failed to parse LLM response: ${content}` };
  }
}
