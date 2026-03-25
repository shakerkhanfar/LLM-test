import { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { getProject } from "../api/client";

export default function Compare() {
  const { id } = useParams();
  const [project, setProject] = useState<any>(null);
  const [selectedRuns, setSelectedRuns] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getProject(id!)
      .then((p) => {
        setProject(p);
        // Auto-select all completed runs
        const completed = p.runs?.filter((r: any) => r.status === "COMPLETE") || [];
        setSelectedRuns(completed.map((r: any) => r.id));
      })
      .finally(() => setLoading(false));
  }, [id]);

  if (loading) return <p>Loading...</p>;
  if (!project) return <p>Project not found</p>;

  const completedRuns = project.runs?.filter((r: any) => r.status === "COMPLETE") || [];
  const runsToCompare = completedRuns.filter((r: any) => selectedRuns.includes(r.id));
  const criteria = project.criteria || [];

  function toggleRun(runId: string) {
    setSelectedRuns((prev) =>
      prev.includes(runId) ? prev.filter((id) => id !== runId) : [...prev, runId]
    );
  }

  return (
    <div>
      <Link to={`/projects/${id}`} style={{ color: "#888", textDecoration: "none", fontSize: 14 }}>
        &larr; Back to project
      </Link>
      <h1 style={{ margin: "16px 0" }}>Compare Runs</h1>

      {/* Run selector */}
      <div style={{ marginBottom: 24, display: "flex", gap: 8, flexWrap: "wrap" }}>
        {completedRuns.map((r: any) => (
          <button
            key={r.id}
            onClick={() => toggleRun(r.id)}
            style={{
              padding: "6px 12px",
              borderRadius: 4,
              border: `1px solid ${selectedRuns.includes(r.id) ? "#2563eb" : "#333"}`,
              background: selectedRuns.includes(r.id) ? "#2563eb22" : "#1a1a1a",
              color: selectedRuns.includes(r.id) ? "#60a5fa" : "#888",
              cursor: "pointer",
              fontSize: 13,
            }}
          >
            {r.modelUsed}
          </button>
        ))}
      </div>

      {runsToCompare.length < 2 ? (
        <p style={{ color: "#666" }}>Select at least 2 runs to compare.</p>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ borderBottom: "1px solid #333" }}>
                <th style={{ padding: "8px 12px", textAlign: "left", fontSize: 13 }}>Criterion</th>
                {runsToCompare.map((r: any) => (
                  <th key={r.id} style={{ padding: "8px 12px", textAlign: "center", fontSize: 13 }}>
                    <Link to={`/projects/${id}/runs/${r.id}`} style={{ color: "#60a5fa", textDecoration: "none" }}>
                      {r.modelUsed}
                    </Link>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {/* Overall score row */}
              <tr style={{ borderBottom: "1px solid #333", background: "#111" }}>
                <td style={{ padding: "8px 12px", fontWeight: 600 }}>Overall Score</td>
                {runsToCompare.map((r: any) => {
                  const score = r.overallScore;
                  const isBest = score === Math.max(...runsToCompare.map((x: any) => x.overallScore ?? 0));
                  return (
                    <td key={r.id} style={{ padding: "8px 12px", textAlign: "center" }}>
                      <span style={{
                        fontWeight: isBest ? 700 : 400,
                        color: score >= 0.8 ? "#22c55e" : score >= 0.5 ? "#f59e0b" : "#ef4444",
                        fontSize: 18,
                      }}>
                        {score != null ? `${(score * 100).toFixed(0)}%` : "—"}
                      </span>
                    </td>
                  );
                })}
              </tr>

              {/* Per-criterion rows */}
              {criteria.map((c: any) => {
                const scores = runsToCompare.map((r: any) => {
                  const er = r.evalResults?.find((e: any) => e.criterionId === c.id);
                  return er?.score;
                });
                const maxScore = Math.max(...scores.filter((s: any) => s != null));

                return (
                  <tr key={c.id} style={{ borderBottom: "1px solid #1a1a1a" }}>
                    <td style={{ padding: "8px 12px" }}>
                      <div>{c.label || c.key}</div>
                      <div style={{ fontSize: 11, color: "#666" }}>{c.type}</div>
                    </td>
                    {runsToCompare.map((r: any, ri: number) => {
                      const er = r.evalResults?.find((e: any) => e.criterionId === c.id);
                      const isBest = scores[ri] === maxScore && scores[ri] != null;
                      return (
                        <td key={r.id} style={{ padding: "8px 12px", textAlign: "center" }}>
                          {er?.score != null ? (
                            <div>
                              <span style={{
                                fontWeight: isBest ? 700 : 400,
                                color: er.passed ? "#22c55e" : "#ef4444",
                              }}>
                                {(er.score * 100).toFixed(0)}%
                              </span>
                              <span style={{ fontSize: 11, color: "#666", marginLeft: 4 }}>
                                {er.passed ? "PASS" : "FAIL"}
                              </span>
                            </div>
                          ) : (
                            <span style={{ color: "#444" }}>—</span>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
