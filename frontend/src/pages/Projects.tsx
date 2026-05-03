import { useEffect, useState, useRef } from "react";
import { Link, useNavigate } from "react-router-dom";
import { listProjects, deleteProject, importProjectBundle } from "../api/client";
import T from "../theme";

export default function Projects() {
  const [projects, setProjects] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();

  useEffect(() => {
    listProjects()
      .then(setProjects)
      .finally(() => setLoading(false));
  }, []);

  async function handleImport(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!fileInputRef.current) return;
    fileInputRef.current.value = "";   // reset so same file can be re-selected
    if (!file) return;
    setImporting(true);
    setImportError(null);
    try {
      const result = await importProjectBundle(file);
      navigate(`/projects/${result.projectId}`);
    } catch (err) {
      setImportError((err as Error).message);
      setImporting(false);
    }
  }

  if (loading) return <p>Loading...</p>;

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 24 }}>
        <h1 style={{ margin: 0 }}>Projects</h1>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {/* Hidden file input for import */}
          <input
            ref={fileInputRef}
            type="file"
            accept=".json"
            style={{ display: "none" }}
            onChange={handleImport}
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={importing}
            style={{
              background: T.card,
              color: T.primary,
              border: `1px solid ${T.primary}`,
              padding: "8px 16px",
              borderRadius: 6,
              fontSize: 14,
              cursor: importing ? "not-allowed" : "pointer",
              opacity: importing ? 0.7 : 1,
            }}
          >
            {importing ? "Importing…" : "Import Project"}
          </button>
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
      </div>

      {importError && (
        <div style={{
          background: "#fef2f2", border: "1px solid #fca5a5", borderRadius: 8,
          padding: "10px 16px", marginBottom: 16, color: "#dc2626", fontSize: 13,
          display: "flex", justifyContent: "space-between", alignItems: "center",
        }}>
          <span>Import failed: {importError}</span>
          <button onClick={() => setImportError(null)} style={{ background: "none", border: "none", cursor: "pointer", color: "#dc2626", fontSize: 16 }}>×</button>
        </div>
      )}

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
                      if (!confirm(`Delete project "${p.name}"? This cannot be undone.`)) return;
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
