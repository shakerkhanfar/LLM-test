/**
 * Prompt Auditor
 *
 * Reviews each workflow node's prompt using an LLM, taking into account:
 *   1. The agent's purpose (agentSummary + agentStructure)
 *   2. User-defined context (evalContext) — e.g. "OOS transfers are not failures"
 *   3. Any extra one-off instructions provided at run time
 *
 * Returns per-node findings + a suggested rewrite for each node.
 * Can also apply approved rewrites directly to the Hamsa agent via PATCH.
 */

import OpenAI from "openai";
import dotenv from "dotenv";
dotenv.config();

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const MODEL = "gpt-4.1";

export interface NodeAudit {
  nodeId: string;
  nodeLabel: string;
  nodeType: string;
  currentPrompt: string;
  issues: Array<{ severity: "critical" | "warning" | "info"; description: string }>;
  suggestedPrompt: string | null;   // null if no changes needed
  reasoning: string;
  changed: boolean;
}

export interface AuditResult {
  nodeAudits: NodeAudit[];
  overallFindings: string[];
  summary: string;
  totalCostUsd: number;
}

// ─── Helpers ──────────────────────────────────────────────────────

function stripFences(s: string): string {
  return s.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
}

function safeJson<T>(s: string, fallback: T): T {
  try { return JSON.parse(stripFences(s)) as T; } catch { return fallback; }
}

function estimateCost(promptTokens: number, completionTokens: number): number {
  // gpt-4.1: $2/M input, $8/M output
  return (promptTokens / 1_000_000) * 2 + (completionTokens / 1_000_000) * 8;
}

// ─── Main audit function ───────────────────────────────────────────

export async function auditAgentPrompts(
  agentSummary: string | null,
  agentStructure: any,
  evalContext: string | null,
  extraInstructions: string | null
): Promise<AuditResult> {
  const nodes: any[] = agentStructure?.workflow?.nodes ?? [];
  const edges: any[] = agentStructure?.workflow?.edges ?? [];

  // Only audit nodes that have a prompt (conversation + start nodes)
  const auditableNodes = nodes.filter(
    (n: any) => n.message && n.message.trim().length > 0
  );

  if (auditableNodes.length === 0) {
    return {
      nodeAudits: [],
      overallFindings: ["No auditable nodes found in the agent workflow."],
      summary: "No conversation nodes with prompts found.",
      totalCostUsd: 0,
    };
  }

  // Build edge map: nodeId → allowed transitions
  const edgeMap = new Map<string, Array<{ targetLabel: string; condition: string }>>();
  for (const e of edges) {
    if (!edgeMap.has(e.source)) edgeMap.set(e.source, []);
    const target = nodes.find((n: any) => n.id === e.target);
    edgeMap.get(e.source)!.push({
      targetLabel: target?.label || e.target,
      condition: e.data?.condition?.description || e.data?.condition?.prompt || "default",
    });
  }

  // Build a compact node list for the overview prompt
  const nodeList = auditableNodes.map((n: any) => {
    const transitions = edgeMap.get(n.id) || [];
    return `[${n.label}] (${n.type})\nPrompt: ${n.message.slice(0, 400)}${n.message.length > 400 ? "…" : ""}\nTransitions: ${transitions.map(t => `→ ${t.targetLabel} (${t.condition})`).join(", ") || "none"}`;
  }).join("\n\n---\n\n");

  // Compose the context block
  const contextParts: string[] = [];
  if (agentSummary) contextParts.push(`AGENT PURPOSE:\n${agentSummary.slice(0, 600)}`);
  if (evalContext) contextParts.push(`PROJECT EVALUATION RULES (always apply these):\n${evalContext}`);
  if (extraInstructions) contextParts.push(`ADDITIONAL INSTRUCTIONS FOR THIS AUDIT:\n${extraInstructions}`);
  const contextBlock = contextParts.length > 0 ? contextParts.join("\n\n") + "\n\n" : "";

  let totalCostUsd = 0;

  // ── Step 1: Overall audit (one LLM call for all nodes) ────────────
  const overviewPrompt = `You are an expert voice AI agent designer auditing an agent's workflow node prompts.

${contextBlock}WORKFLOW NODES TO AUDIT:
${nodeList}

Review every node's prompt and identify:
1. Ambiguous or incomplete instructions the agent might misinterpret
2. Missing edge case handling (e.g., user provides partial info, gives wrong format, goes off-topic)
3. Instructions that conflict with the project's evaluation rules (e.g., if OOS transfers = success, the prompt should clearly instruct the agent to handle OOS requests gracefully and transfer, not apologize or loop)
4. Transitions that may be wrongly triggered or missing

Respond with JSON:
{
  "overall_findings": ["finding 1", "finding 2", ...],
  "summary": "2-3 sentence overall assessment",
  "node_issues": {
    "NODE_LABEL": {
      "issues": [{ "severity": "critical|warning|info", "description": "..." }],
      "needs_rewrite": true/false,
      "reasoning": "why this node needs or doesn't need changes"
    }
  }
}`;

  const overviewResp = await openai.chat.completions.create({
    model: MODEL,
    messages: [{ role: "user", content: overviewPrompt }],
    temperature: 0.2,
    max_tokens: 3000,
  });

  const overviewUsage = overviewResp.usage;
  if (overviewUsage) {
    totalCostUsd += estimateCost(overviewUsage.prompt_tokens, overviewUsage.completion_tokens);
  }

  const overview = safeJson<{
    overall_findings: string[];
    summary: string;
    node_issues: Record<string, {
      issues: Array<{ severity: "critical" | "warning" | "info"; description: string }>;
      needs_rewrite: boolean;
      reasoning: string;
    }>;
  }>(overviewResp.choices[0].message.content || "", {
    overall_findings: [],
    summary: "",
    node_issues: {},
  });

  // Build a case-insensitive lookup for node issues returned by LLM
  // (LLM may return labels with different casing/spacing than actual node labels)
  const nodeIssuesNormalized = new Map<string, typeof overview.node_issues[string]>();
  for (const [label, info] of Object.entries(overview.node_issues)) {
    nodeIssuesNormalized.set(label.trim().toLowerCase(), info);
  }
  function getNodeInfo(label: string) {
    return overview.node_issues[label]
      ?? nodeIssuesNormalized.get(label.trim().toLowerCase())
      ?? null;
  }

  // ── Step 2: Per-node rewrite for nodes that need it ──────────────
  const nodeAudits: NodeAudit[] = [];
  const nodesNeedingRewrite = auditableNodes.filter((n: any) => {
    const info = getNodeInfo(n.label);
    return info?.needs_rewrite;
  });

  // Batch rewrites — send up to 5 nodes per call to keep cost down
  const BATCH_SIZE = 5;
  for (let i = 0; i < nodesNeedingRewrite.length; i += BATCH_SIZE) {
    const batch = nodesNeedingRewrite.slice(i, i + BATCH_SIZE);

    const rewriteItems = batch.map((n: any) => {
      const transitions = edgeMap.get(n.id) || [];
      const nodeInfo = getNodeInfo(n.label) || { issues: [], reasoning: "" };
      return `NODE: "${n.label}" (${n.type})
CURRENT PROMPT:
${n.message}

TRANSITIONS AVAILABLE: ${transitions.map(t => `→ "${t.targetLabel}" when: ${t.condition}`).join(" | ") || "none"}
ISSUES IDENTIFIED: ${nodeInfo.issues.map(i => `[${i.severity}] ${i.description}`).join("; ") || "none"}`;
    }).join("\n\n===\n\n");

    const rewritePrompt = `You are an expert voice AI agent designer. Rewrite the following node prompts to fix the identified issues.

${contextBlock}Rewrite rules:
- Keep the agent's voice and purpose intact — only fix the problems
- Be specific and unambiguous (voice agents need very clear instructions)
- If evaluation rules say something is a success (e.g., OOS transfer), make sure the prompt reflects that the agent handles it confidently, not apologetically
- Do NOT add unnecessary length — concise is better
- Match the original language (Arabic/English/mixed)

NODES TO REWRITE:
${rewriteItems}

Respond with JSON where each key is the exact node label:
{
  "NODE_LABEL": {
    "rewritten_prompt": "...",
    "changes_made": "brief summary of what changed and why"
  }
}`;

    const rewriteResp = await openai.chat.completions.create({
      model: MODEL,
      messages: [{ role: "user", content: rewritePrompt }],
      temperature: 0.3,
      max_tokens: 4000,
    });

    const rewriteUsage = rewriteResp.usage;
    if (rewriteUsage) {
      totalCostUsd += estimateCost(rewriteUsage.prompt_tokens, rewriteUsage.completion_tokens);
    }

    const rewrites = safeJson<Record<string, { rewritten_prompt: string; changes_made: string }>>(
      rewriteResp.choices[0].message.content || "",
      {}
    );

    for (const n of batch) {
      const nodeInfo = getNodeInfo(n.label) || { issues: [], reasoning: "" };
      const rewrite = rewrites[n.label];
      nodeAudits.push({
        nodeId: n.id,
        nodeLabel: n.label,
        nodeType: n.type,
        currentPrompt: n.message,
        issues: nodeInfo.issues || [],
        suggestedPrompt: rewrite?.rewritten_prompt || null,
        reasoning: rewrite?.changes_made || nodeInfo.reasoning || "",
        changed: !!rewrite?.rewritten_prompt,
      });
    }
  }

  // Add clean nodes (no rewrite needed)
  for (const n of auditableNodes) {
    if (!nodesNeedingRewrite.find((r: any) => r.id === n.id)) {
      const nodeInfo = getNodeInfo(n.label);
      nodeAudits.push({
        nodeId: n.id,
        nodeLabel: n.label,
        nodeType: n.type,
        currentPrompt: n.message,
        issues: nodeInfo?.issues || [],
        suggestedPrompt: null,
        reasoning: nodeInfo?.reasoning || "No changes needed.",
        changed: false,
      });
    }
  }

  // Preserve original node order
  const nodeOrderMap = new Map(auditableNodes.map((n: any, i: number) => [n.id, i]));
  nodeAudits.sort((a, b) => (nodeOrderMap.get(a.nodeId) ?? 999) - (nodeOrderMap.get(b.nodeId) ?? 999));

  return {
    nodeAudits,
    overallFindings: overview.overall_findings || [],
    summary: overview.summary || "",
    totalCostUsd,
  };
}
