import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { listProjects, deleteProject } from "../api/client";
import T from "../theme";

export default function Projects() {
  const [projects, setProjects] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    listProjects()
      .then(setProjects)
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <p>Loading...</p>;

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 24 }}>
        <h1 style={{ margin: 0 }}>Projects</h1>
        <Link
          to="/projects/new"
          style={{
            background: T.primary,
            color: T.primaryText,
            padding: "8px 16px",
            borderRadius: 6,
            textDecoration: "none",
            fontSize: 14,
          }}
        >
          + New Project
        </Link>
      </div>

      {projects.length === 0 ? (
        <p style={{ color: T.textMuted }}>No projects yet. Create one to get started.</p>
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ borderBottom: `1px solid ${T.border}`, textAlign: "left" }}>
              <th style={{ padding: "8px 12px" }}>Name</th>
              <th style={{ padding: "8px 12px" }}>Type</th>
              <th style={{ padding: "8px 12px" }}>Agent ID</th>
              <th style={{ padding: "8px 12px" }}>Criteria</th>
              <th style={{ padding: "8px 12px" }}>Runs</th>
              <th style={{ padding: "8px 12px" }}>Last Run</th>
              <th style={{ padding: "8px 12px" }}></th>
            </tr>
          </thead>
          <tbody>
            {projects.map((p) => (
              <tr key={p.id} style={{ borderBottom: `1px solid ${T.borderLight}` }}>
                <td style={{ padding: "8px 12px" }}>
                  <Link to={`/projects/${p.id}`} style={{ color: T.link, textDecoration: "none" }}>
                    {p.name}
                  </Link>
                </td>
                <td style={{ padding: "8px 12px" }}>
                  <span style={{
                    fontSize: 10, padding: "2px 6px", borderRadius: 3,
                    background: p.projectType === "WEBHOOK" ? "#f3e8ff" : p.projectType === "HISTORY" ? T.infoBg : T.successBg,
                    color: p.projectType === "WEBHOOK" ? "#a855f7" : p.projectType === "HISTORY" ? "#3b82f6" : "#22c55e",
                  }}>
                    {p.projectType || "LIVE"}
                  </span>
                </td>
                <td style={{ padding: "8px 12px", fontFamily: "monospace", fontSize: 12, color: T.textSecondary }}>
                  {p.agentId?.slice(0, 12)}...
                </td>
                <td style={{ padding: "8px 12px" }}>{p._count?.criteria ?? 0}</td>
                <td style={{ padding: "8px 12px" }}>{p._count?.runs ?? 0}</td>
                <td style={{ padding: "8px 12px", fontSize: 12, color: T.textSecondary }}>
                  {p.runs?.[0]
                    ? `${p.runs[0].modelUsed || p.projectType || "—"} — ${new Date(p.runs[0].createdAt).toLocaleDateString()}`
                    : "—"}
                </td>
                <td style={{ padding: "8px 12px" }}>
                  <button
                    onClick={async () => {
                      await deleteProject(p.id);
                      setProjects((prev) => prev.filter((x) => x.id !== p.id));
                    }}
                    style={{
                      background: "none",
                      border: "none",
                      color: T.textMuted,
                      cursor: "pointer",
                      fontSize: 12,
                    }}
                  >
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
