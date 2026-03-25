import OpenAI from "openai";
import dotenv from "dotenv";
dotenv.config();

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/**
 * Simple LLM judge for transcript-based criteria (language, gender, etc.)
 * Uses gpt-4.1-mini for speed.
 */
export async function evaluateWithLLMJudge(
  rule: string,
  transcriptText: string
): Promise<{ passed: boolean; score: number; detail: string }> {
  // If transcriptText is empty, the rule IS the full prompt (used by FLOW_PROGRESSION)
  const isFullPrompt = !transcriptText;

  const prompt = isFullPrompt
    ? rule
    : `You are evaluating a voice AI agent transcript for an Arabic-first voice AI platform.

Evaluation rule: "${rule}"

Transcript:
${transcriptText}

Respond with JSON only:
{
  "passed": true | false,
  "score": 0.0 to 1.0,
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
    return { passed: false, score: 0, detail: "LLM judge returned empty response" };
  }

  try {
    const result = JSON.parse(content);
    return {
      passed: Boolean(result.passed),
      score: Number(result.score) || 0,
      detail: String(result.detail || ""),
    };
  } catch {
    return { passed: false, score: 0, detail: `Failed to parse LLM response: ${content}` };
  }
}
