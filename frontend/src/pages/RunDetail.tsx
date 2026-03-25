import { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { getRun, createLabel, deleteLabel, triggerEvaluation } from "../api/client";

const LABEL_TYPES = ["WRONG_WORD", "WRONG_LANGUAGE", "WRONG_GENDER", "HALLUCINATED"] as const;
const LABEL_COLORS: Record<string, string> = {
  WRONG_WORD: "#ef4444",
  WRONG_LANGUAGE: "#f59e0b",
  WRONG_GENDER: "#a855f7",
  HALLUCINATED: "#ec4899",
};

export default function RunDetail() {
  const { id, runId } = useParams();
  const [run, setRun] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [labelingWord, setLabelingWord] = useState<{ wordIndex: number; utteranceIndex: number; word: string } | null>(null);

  const load = () => {
    getRun(runId!)
      .then(setRun)
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, [runId]);

  if (loading) return <p>Loading...</p>;
  if (!run) return <p>Run not found</p>;

  const transcript = (run.transcript || []) as any[];
  const evalResults = (run.evalResults || []) as any[];
  const wordLabels = (run.wordLabels || []) as any[];

  // Flatten words for labeling
  let globalWordIndex = 0;
  const flatWords: Array<{ word: string; utteranceIndex: number; globalIndex: number; speaker: string }> = [];
  transcript.forEach((utt: any, ui: number) => {
    const text = utt.Agent || utt.User || "";
    const speaker = utt.Agent ? "Agent" : "User";
    text.split(/\s+/).filter(Boolean).forEach((w: string) => {
      flatWords.push({ word: w, utteranceIndex: ui, globalIndex: globalWordIndex, speaker });
      globalWordIndex++;
    });
  });

  async function handleLabel(type: string, correction?: string) {
    if (!labelingWord) return;
    await createLabel(runId!, {
      wordIndex: labelingWord.wordIndex,
      utteranceIndex: labelingWord.utteranceIndex,
      originalWord: labelingWord.word,
      labelType: type,
      correction: correction || null,
    });
    setLabelingWord(null);
    load();
  }

  async function handleRemoveLabel(labelId: string) {
    await deleteLabel(labelId);
    load();
  }

  return (
    <div>
      <Link to={`/projects/${id}`} style={{ color: "#888", textDecoration: "none", fontSize: 14 }}>
        &larr; Back to project
      </Link>

      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", gap: 16, margin: "16px 0" }}>
        <h1 style={{ margin: 0 }}>{run.modelUsed}</h1>
        <span style={{ color: run.status === "COMPLETE" ? "#22c55e" : "#f59e0b", fontSize: 14 }}>
          {run.status}
        </span>
        {run.status !== "COMPLETE" && (run.callLog || run.transcript) && (
          <button
            onClick={async () => { await triggerEvaluation(runId!); load(); }}
            style={{ background: "#2563eb", color: "#fff", padding: "6px 12px", borderRadius: 4, border: "none", cursor: "pointer", fontSize: 12 }}
          >
            Re-evaluate
          </button>
        )}
      </div>

      {/* Score summary */}
      {run.overallScore != null && (
        <div style={{ marginBottom: 24 }}>
          <div style={{ fontSize: 14, color: "#888", marginBottom: 8 }}>Overall Score</div>
          <div style={{ fontSize: 36, fontWeight: 700, color: run.overallScore >= 0.8 ? "#22c55e" : run.overallScore >= 0.5 ? "#f59e0b" : "#ef4444" }}>
            {(run.overallScore * 100).toFixed(0)}%
          </div>
        </div>
      )}

      {/* Per-criterion breakdown */}
      {evalResults.length > 0 && (
        <div style={{ marginBottom: 32 }}>
          <h2 style={{ fontSize: 16, marginBottom: 12 }}>Criteria Results</h2>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ borderBottom: "1px solid #333", textAlign: "left" }}>
                <th style={{ padding: "6px 12px", fontSize: 13 }}>Criterion</th>
                <th style={{ padding: "6px 12px", fontSize: 13 }}>Type</th>
                <th style={{ padding: "6px 12px", fontSize: 13 }}>Score</th>
                <th style={{ padding: "6px 12px", fontSize: 13 }}>Pass</th>
                <th style={{ padding: "6px 12px", fontSize: 13 }}>Detail</th>
              </tr>
            </thead>
            <tbody>
              {evalResults.map((er: any) => (
                <tr key={er.id} style={{ borderBottom: "1px solid #1a1a1a" }}>
                  <td style={{ padding: "6px 12px" }}>{er.criterion?.label || er.criterion?.key}</td>
                  <td style={{ padding: "6px 12px", fontSize: 12, color: "#888" }}>{er.criterion?.type}</td>
                  <td style={{ padding: "6px 12px" }}>
                    {er.score != null ? `${(er.score * 100).toFixed(0)}%` : "—"}
                  </td>
                  <td style={{ padding: "6px 12px" }}>
                    {er.passed != null ? (
                      <span style={{ color: er.passed ? "#22c55e" : "#ef4444" }}>
                        {er.passed ? "PASS" : "FAIL"}
                      </span>
                    ) : "—"}
                  </td>
                  <td style={{ padding: "6px 12px", fontSize: 12, color: "#aaa", maxWidth: 400 }}>
                    {er.detail}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Transcript with word labeling */}
      {transcript.length > 0 && (
        <div style={{ marginBottom: 32 }}>
          <h2 style={{ fontSize: 16, marginBottom: 12 }}>
            Transcript
            <span style={{ fontSize: 12, color: "#888", marginLeft: 8 }}>
              (click words to label)
            </span>
          </h2>
          <div style={{ background: "#111", borderRadius: 8, padding: 16, border: "1px solid #222" }}>
            {transcript.map((utt: any, ui: number) => {
              const isAgent = !!utt.Agent;
              const text = utt.Agent || utt.User || "";
              const words = text.split(/\s+/).filter(Boolean);
              const speaker = isAgent ? "Agent" : "User";
              const gender = utt.metadata?.gender;

              return (
                <div key={ui} style={{ marginBottom: 12, direction: "rtl", textAlign: "right" }}>
                  <span style={{ fontSize: 11, color: isAgent ? "#3b82f6" : "#22c55e", marginLeft: 8, direction: "ltr" }}>
                    [{speaker}{gender && gender !== "unknown" ? ` - ${gender}` : ""}]
                  </span>
                  <div style={{ direction: "rtl", lineHeight: 2 }}>
                    {words.map((word: string, wi: number) => {
                      const gIdx = flatWords.findIndex(
                        (fw) => fw.utteranceIndex === ui && fw.word === word && fw.globalIndex >= (flatWords.find(f => f.utteranceIndex === ui)?.globalIndex ?? 0)
                      );
                      const actualGlobalIndex = flatWords[gIdx]?.globalIndex ?? wi;
                      const label = wordLabels.find((l: any) => l.wordIndex === actualGlobalIndex);

                      return (
                        <span
                          key={wi}
                          onClick={() =>
                            setLabelingWord({ wordIndex: actualGlobalIndex, utteranceIndex: ui, word })
                          }
                          style={{
                            cursor: "pointer",
                            padding: "2px 4px",
                            borderRadius: 3,
                            background: label ? `${LABEL_COLORS[label.labelType]}22` : "transparent",
                            borderBottom: label ? `2px solid ${LABEL_COLORS[label.labelType]}` : "none",
                            position: "relative",
                          }}
                          title={label ? `${label.labelType}${label.correction ? ` → ${label.correction}` : ""}` : "Click to label"}
                        >
                          {word}{" "}
                        </span>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Labeling popup */}
          {labelingWord && (
            <div style={{
              position: "fixed", top: "50%", left: "50%", transform: "translate(-50%, -50%)",
              background: "#1a1a1a", border: "1px solid #333", borderRadius: 8, padding: 20,
              zIndex: 1000, minWidth: 280,
            }}>
              <div style={{ fontSize: 14, marginBottom: 12 }}>
                Label word: <strong style={{ color: "#fff" }}>{labelingWord.word}</strong>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {LABEL_TYPES.map((type) => (
                  <button
                    key={type}
                    onClick={() => handleLabel(type)}
                    style={{
                      background: `${LABEL_COLORS[type]}22`,
                      color: LABEL_COLORS[type],
                      border: `1px solid ${LABEL_COLORS[type]}44`,
                      padding: "6px 12px",
                      borderRadius: 4,
                      cursor: "pointer",
                      fontSize: 13,
                      textAlign: "left",
                    }}
                  >
                    {type.replace(/_/g, " ")}
                  </button>
                ))}
                {/* Check if already labeled — show remove option */}
                {wordLabels.find((l: any) => l.wordIndex === labelingWord.wordIndex) && (
                  <button
                    onClick={() => {
                      const existing = wordLabels.find((l: any) => l.wordIndex === labelingWord.wordIndex);
                      if (existing) handleRemoveLabel(existing.id);
                    }}
                    style={{ background: "none", color: "#666", border: "1px solid #333", padding: "6px 12px", borderRadius: 4, cursor: "pointer", fontSize: 13 }}
                  >
                    Remove Label
                  </button>
                )}
                <button
                  onClick={() => setLabelingWord(null)}
                  style={{ background: "none", color: "#888", border: "none", cursor: "pointer", fontSize: 12, marginTop: 4 }}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
          {labelingWord && (
            <div
              onClick={() => setLabelingWord(null)}
              style={{ position: "fixed", top: 0, left: 0, right: 0, bottom: 0, background: "rgba(0,0,0,0.5)", zIndex: 999 }}
            />
          )}

          {/* Word accuracy stats */}
          {wordLabels.length > 0 && (
            <div style={{ marginTop: 16, padding: 12, background: "#111", borderRadius: 6, border: "1px solid #222" }}>
              <span style={{ fontSize: 13, color: "#888" }}>
                Labels: {wordLabels.length} / {flatWords.length} words |{" "}
                {LABEL_TYPES.map((t) => {
                  const count = wordLabels.filter((l: any) => l.labelType === t).length;
                  return count > 0 ? (
                    <span key={t} style={{ color: LABEL_COLORS[t], marginRight: 12 }}>
                      {t.replace(/_/g, " ")}: {count}
                    </span>
                  ) : null;
                })}
              </span>
            </div>
          )}
        </div>
      )}

      {/* Call Log timeline */}
      {run.callLog && (
        <div style={{ marginBottom: 32 }}>
          <h2 style={{ fontSize: 16, marginBottom: 12 }}>Call Log Timeline</h2>
          <div style={{ background: "#111", borderRadius: 8, padding: 16, border: "1px solid #222", maxHeight: 400, overflow: "auto" }}>
            {(run.callLog as any[])
              .filter((e: any) => e.type === "INFO")
              .map((event: any, i: number) => (
                <div key={i} style={{ display: "flex", gap: 12, marginBottom: 6, fontSize: 12 }}>
                  <span style={{ color: "#666", fontFamily: "monospace", whiteSpace: "nowrap" }}>
                    {event.timestamp?.split("T")[1]?.slice(0, 12)}
                  </span>
                  <span style={{
                    color: event.category === "node_movement" ? "#3b82f6"
                      : event.category === "TOOLS" ? "#f59e0b"
                      : event.category === "VARIABLE_EXTRACTION" || event.category === "VARIABLE" ? "#a855f7"
                      : event.category === "ROUTER" ? "#ec4899"
                      : "#888",
                    width: 140,
                    flexShrink: 0,
                  }}>
                    {event.category}
                  </span>
                  <span style={{ color: "#ccc" }}>{event.message}</span>
                  {event.node_id && (
                    <span style={{ color: "#555", fontFamily: "monospace" }}>
                      [{event.node_id.slice(0, 10)}]
                    </span>
                  )}
                </div>
              ))}
          </div>
        </div>
      )}
    </div>
  );
}
