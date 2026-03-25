import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { listProjects, deleteProject } from "../api/client";

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
            background: "#2563eb",
            color: "#fff",
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
        <p style={{ color: "#666" }}>No projects yet. Create one to get started.</p>
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ borderBottom: "1px solid #333", textAlign: "left" }}>
              <th style={{ padding: "8px 12px" }}>Name</th>
              <th style={{ padding: "8px 12px" }}>Agent ID</th>
              <th style={{ padding: "8px 12px" }}>Criteria</th>
              <th style={{ padding: "8px 12px" }}>Runs</th>
              <th style={{ padding: "8px 12px" }}>Last Run</th>
              <th style={{ padding: "8px 12px" }}></th>
            </tr>
          </thead>
          <tbody>
            {projects.map((p) => (
              <tr key={p.id} style={{ borderBottom: "1px solid #1a1a1a" }}>
                <td style={{ padding: "8px 12px" }}>
                  <Link to={`/projects/${p.id}`} style={{ color: "#60a5fa", textDecoration: "none" }}>
                    {p.name}
                  </Link>
                </td>
                <td style={{ padding: "8px 12px", fontFamily: "monospace", fontSize: 12, color: "#888" }}>
                  {p.agentId?.slice(0, 12)}...
                </td>
                <td style={{ padding: "8px 12px" }}>{p._count?.criteria ?? 0}</td>
                <td style={{ padding: "8px 12px" }}>{p._count?.runs ?? 0}</td>
                <td style={{ padding: "8px 12px", fontSize: 12, color: "#888" }}>
                  {p.runs?.[0]
                    ? `${p.runs[0].modelUsed} — ${new Date(p.runs[0].createdAt).toLocaleDateString()}`
                    : "—"}
                </td>
                <td style={{ padding: "8px 12px" }}>
                  <button
                    onClick={async () => {
                      if (confirm("Delete this project?")) {
                        await deleteProject(p.id);
                        setProjects((prev) => prev.filter((x) => x.id !== p.id));
                      }
                    }}
                    style={{
                      background: "none",
                      border: "none",
                      color: "#666",
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
