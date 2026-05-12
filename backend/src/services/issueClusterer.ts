/**
 * Semantic issue clustering for the report comparison view.
 *
 * Within each window, issues that share the same underlying meaning (but were
 * phrased differently by the LLM evaluator across runs) are merged into one
 * ClusteredIssue. Clusters are then matched across the two windows using
 * embedding cosine similarity so "resolved" means the concept is genuinely
 * absent in B — not just phrased differently.
 *
 * Requires OPENAI_API_KEY. Returns null on missing key or API failure so
 * callers can fall back gracefully to exact-text matching.
 */

import OpenAI from "openai";
import type { Issue, IssueOccurrence, IssueSource } from "./reportComparison";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ── Public types ─────────────────────────────────────────────────────────────

export interface IssueVariant {
  text: string;
  count: number;
  nodeLabel?: string;
  source: IssueSource;
}

export interface ClusteredIssue {
  /** The most-frequent variant's text — used as the display label. */
  canonicalText: string;
  /** All semantic variants that were merged into this cluster. */
  variants: IssueVariant[];
  totalCount: number;
  source: IssueSource;
  severity?: "critical" | "high" | "medium" | "low";
  /** All unique node labels across variants (may be empty). */
  nodeLabels: string[];
  occurrences: IssueOccurrence[];
  occurrencesTruncated: boolean;
  firstSeen: string | null;
  lastSeen: string | null;
}

export interface ClusteredMatchedPair {
  left: ClusteredIssue;
  right: ClusteredIssue;
  /** Cosine similarity between the two cluster representatives (0-1). */
  similarity: number;
  /** right.totalCount - left.totalCount. Negative = improved. */
  countDelta: number;
  /** Percentage change. Null when left.totalCount === 0. */
  deltaPercent: number | null;
  /** Derived trend label. */
  status: "reduced" | "worsened" | "unchanged";
}

export interface ClusteredComparisonResult {
  /** Clusters present in left but absent in right — genuinely resolved. */
  resolved: ClusteredIssue[];
  /** Clusters present in right but absent in left — genuinely new. */
  newIssues: ClusteredIssue[];
  /** Clusters present in both windows — persisting issues with a count delta. */
  persisting: ClusteredMatchedPair[];
  /** Total cluster counts per section (for summary line). */
  stats: {
    resolvedClusters: number;
    newClusters: number;
    persistingClusters: number;
    leftClusterCount: number;
    rightClusterCount: number;
  };
}

// ── Constants ────────────────────────────────────────────────────────────────

/** Cosine similarity threshold for merging two issues into the same cluster. */
const CLUSTER_THRESHOLD = 0.88;

/** Cosine similarity threshold for matching a left cluster to a right cluster. */
const MATCH_THRESHOLD = 0.82;

/** Maximum unique texts to embed per window. Top by count so we cover the
 *  high-impact issues. Low-count noise stays in the exact-match section. */
const MAX_EMBED_TEXTS = 800;

const EMBED_BATCH_SIZE = 512;

// ── Embedding helpers ────────────────────────────────────────────────────────

function cosineSim(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

async function embedTexts(texts: string[]): Promise<Map<string, number[]>> {
  const result = new Map<string, number[]>();
  if (texts.length === 0) return result;
  for (let i = 0; i < texts.length; i += EMBED_BATCH_SIZE) {
    const batch = texts.slice(i, i + EMBED_BATCH_SIZE);
    const response = await openai.embeddings.create({
      model: "text-embedding-3-small",
      input: batch,
    });
    for (let j = 0; j < batch.length; j++) {
      result.set(batch[j], response.data[j].embedding);
    }
  }
  return result;
}

// ── Within-window clustering ─────────────────────────────────────────────────

function clusterIssues(
  issues: Issue[],
  embedMap: Map<string, number[]>,
): ClusteredIssue[] {
  // Sort by count descending so high-frequency issues become cluster anchors.
  const sorted = [...issues].sort((a, b) => b.count - a.count);

  const clusters: Array<{
    anchorEmb: number[] | null;
    members: Issue[];
  }> = [];

  for (const issue of sorted) {
    const emb = embedMap.get(issue.text) ?? null;

    if (emb && clusters.length > 0) {
      let bestSim = -1;
      let bestIdx = -1;
      for (let i = 0; i < clusters.length; i++) {
        if (!clusters[i].anchorEmb) continue;
        const sim = cosineSim(emb, clusters[i].anchorEmb!);
        if (sim > bestSim) {
          bestSim = sim;
          bestIdx = i;
        }
      }
      if (bestSim >= CLUSTER_THRESHOLD && bestIdx >= 0) {
        clusters[bestIdx].members.push(issue);
        continue;
      }
    }
    clusters.push({ anchorEmb: emb, members: [issue] });
  }

  return clusters.map(cluster => {
    const canonical = cluster.members[0]; // highest-count member
    const totalCount = cluster.members.reduce((s, m) => s + m.count, 0);

    const nodeLabels = [
      ...new Set(
        cluster.members.map(m => m.nodeLabel).filter((n): n is string => !!n)
      ),
    ];

    const allOccurrences = cluster.members.flatMap(m => m.occurrences);
    const occurrencesTruncated =
      allOccurrences.length > 50 || cluster.members.some(m => m.occurrencesTruncated);

    const firstSeen = cluster.members.reduce<string | null>((min, m) => {
      if (!m.firstSeen) return min;
      return !min || m.firstSeen < min ? m.firstSeen : min;
    }, null);
    const lastSeen = cluster.members.reduce<string | null>((max, m) => {
      if (!m.lastSeen) return max;
      return !max || m.lastSeen > max ? m.lastSeen : max;
    }, null);

    return {
      canonicalText: canonical.text,
      variants: cluster.members.map(m => ({
        text: m.text,
        count: m.count,
        nodeLabel: m.nodeLabel,
        source: m.source,
      })),
      totalCount,
      source: canonical.source,
      severity: canonical.severity,
      nodeLabels,
      occurrences: allOccurrences.slice(0, 50),
      occurrencesTruncated,
      firstSeen,
      lastSeen,
    };
  });
}

// ── Cross-window matching ────────────────────────────────────────────────────

function matchClusters(
  leftClusters: ClusteredIssue[],
  rightClusters: ClusteredIssue[],
  embedMap: Map<string, number[]>,
): ClusteredComparisonResult {
  const matchedRightIndices = new Set<number>();
  const persisting: ClusteredMatchedPair[] = [];
  const resolved: ClusteredIssue[] = [];

  for (const lc of leftClusters) {
    const embL = embedMap.get(lc.canonicalText);
    if (!embL) {
      resolved.push(lc);
      continue;
    }

    let bestSim = -1;
    let bestRi = -1;
    for (let ri = 0; ri < rightClusters.length; ri++) {
      if (matchedRightIndices.has(ri)) continue;
      const embR = embedMap.get(rightClusters[ri].canonicalText);
      if (!embR) continue;
      const sim = cosineSim(embL, embR);
      if (sim > bestSim) {
        bestSim = sim;
        bestRi = ri;
      }
    }

    if (bestSim >= MATCH_THRESHOLD && bestRi >= 0) {
      matchedRightIndices.add(bestRi);
      const rc = rightClusters[bestRi];
      const delta = rc.totalCount - lc.totalCount;
      const deltaPercent =
        lc.totalCount > 0
          ? parseFloat(((delta / lc.totalCount) * 100).toFixed(1))
          : null;
      const status: ClusteredMatchedPair["status"] =
        delta < 0 ? "reduced" : delta > 0 ? "worsened" : "unchanged";
      persisting.push({
        left: lc,
        right: rc,
        similarity: parseFloat(bestSim.toFixed(3)),
        countDelta: delta,
        deltaPercent,
        status,
      });
    } else {
      resolved.push(lc);
    }
  }

  const newIssues = rightClusters.filter((_, ri) => !matchedRightIndices.has(ri));

  return {
    resolved,
    newIssues,
    persisting,
    stats: {
      resolvedClusters: resolved.length,
      newClusters: newIssues.length,
      persistingClusters: persisting.length,
      leftClusterCount: leftClusters.length,
      rightClusterCount: rightClusters.length,
    },
  };
}

// ── Public entry point ───────────────────────────────────────────────────────

export async function clusterAndMatchIssues(
  leftIssues: Issue[],
  rightIssues: Issue[],
): Promise<ClusteredComparisonResult | null> {
  if (!process.env.OPENAI_API_KEY) return null;

  try {
    // Collect unique texts from both sides, capped at MAX_EMBED_TEXTS per side
    // (sorted by count so we always embed the most-impactful ones).
    const topLeft  = [...leftIssues].sort((a, b) => b.count - a.count).slice(0, MAX_EMBED_TEXTS);
    const topRight = [...rightIssues].sort((a, b) => b.count - a.count).slice(0, MAX_EMBED_TEXTS);
    const uniqueTexts = [...new Set([...topLeft, ...topRight].map(i => i.text))];

    const embedMap = await embedTexts(uniqueTexts);

    const leftClusters  = clusterIssues(topLeft,  embedMap);
    const rightClusters = clusterIssues(topRight, embedMap);

    return matchClusters(leftClusters, rightClusters, embedMap);
  } catch (err) {
    console.error("[issueClusterer] embedding/clustering failed:", err instanceof Error ? err.message : err);
    return null;
  }
}
