import { useEffect, useState, useRef } from "react";
import { Link, useNavigate } from "react-router-dom";
import { listProjects, deleteProject, importProjectBundle } from "../api/client";
import T from "../theme";

export default function Projects() {
  const [projects, setProjects] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  // Pending merge: files selected but not yet confirmed by the user
  const [pendingMerge, setPendingMerge] = useState<{ files: File[]; names: string[] } | null>(null);
  // Warnings returned from a successful import (criteria renamed, metadata differences, etc.)
  const [importWarnings, setImportWarnings] = useState<{ warnings: string[]; projectId: string } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();

  useEffect(() => {
    listProjects()
      .then(setProjects)
      .finally(() => setLoading(false));
  }, []);

  async function handleImport(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    if (files.length === 0) return;
    if (fileInputRef.current) fileInputRef.current.value = "";

    const totalMB = files.reduce((sum, f) => sum + f.size, 0) / (1024 * 1024);
    if (totalMB > 200) {
      setImportError(`Selected files total ${totalMB.toFixed(0)} MB — too large (max 200 MB). Try exporting without transcripts.`);
      return;
    }

    if (files.length > 1) {
      // Show a confirmation step before committing to a merge
      setPendingMerge({ files, names: files.map(f => f.name) });
      return;
    }

    await runImport(files);
  }

  async function runImport(files: File[]) {
    setPendingMerge(null);
    setImporting(true);
    setImportError(null);
    setImportWarnings(null);
    try {
      // Read all files in parallel, then validate structure
      const texts = await Promise.all(files.map(f => f.text()));
      const bundles: any[] = texts.map((text, i) => {
        let bundle: any;
        try { bundle = JSON.parse(text); } catch { throw new Error(`${files[i].name} is not valid JSON.`); }
        if (!bundle?.project || !Array.isArray(bundle.criteria) || !Array.isArray(bundle.runs)) {
          throw new Error(`${files[i].name} is not a valid Hamsa export bundle.`);
        }
        return bundle;
      });

      const result = await importProjectBundle(bundles);
      const allWarnings = result.warnings ?? (result.warning ? [result.warning] : []);
      if (allWarnings.length > 0) {
        // Surface warnings visibly rather than just logging — criteria were renamed or
        // metadata differed across bundles, and the user should know before navigating away.
        setImportWarnings({ warnings: allWarnings, projectId: result.projectId });
        setImporting(false);
      } else {
        navigate(`/projects/${result.projectId}`);
      }
    } catch (err) {
      const msg = (err as Error).message;
      const friendly = msg.includes("Unique constraint")
        ? "Duplicate key conflict — try importing again."
        : msg;
      setImportError(friendly);
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
            multiple
            style={{ display: "none" }}
            onChange={handleImport}
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={importing}
            title="Select one bundle to import, or multiple to merge into a single project"
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
            {importing ? "Importing…" : "Import / Merge Projects"}
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

      {/* Merge confirmation — shown when user picks 2+ files */}
      {pendingMerge && (
        <div style={{
          background: "#eff6ff", border: "1px solid #93c5fd", borderRadius: 8,
          padding: "12px 16px", marginBottom: 16, fontSize: 13, color: "#1e40af",
        }}>
          <p style={{ margin: "0 0 8px 0", fontWeight: 600 }}>
            Merge {pendingMerge.files.length} projects into one?
          </p>
          <ul style={{ margin: "0 0 10px 0", paddingLeft: 20 }}>
            {pendingMerge.names.map(n => <li key={n}>{n}</li>)}
          </ul>
          <p style={{ margin: "0 0 10px 0", color: "#1d4ed8" }}>
            A new project named <strong>Merged: …</strong> will be created. The originals are not deleted.
            Criteria with the same name but different definitions will be imported with a numeric suffix (e.g. <code>intent_match_2</code>).
          </p>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              onClick={() => runImport(pendingMerge.files)}
              style={{ background: "#2563eb", color: "#fff", border: "none", padding: "6px 14px", borderRadius: 5, cursor: "pointer", fontSize: 13 }}
            >
              Confirm Merge
            </button>
            <button
              onClick={() => setPendingMerge(null)}
              style={{ background: "none", border: "1px solid #93c5fd", color: "#1e40af", padding: "6px 14px", borderRadius: 5, cursor: "pointer", fontSize: 13 }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Warnings from a successful import (criteria renamed, metadata differences, etc.) */}
      {importWarnings && (
        <div style={{
          background: "#fffbeb", border: "1px solid #fcd34d", borderRadius: 8,
          padding: "12px 16px", marginBottom: 16, fontSize: 13, color: "#92400e",
        }}>
          <p style={{ margin: "0 0 6px 0", fontWeight: 600 }}>Import completed with notices:</p>
          <ul style={{ margin: "0 0 10px 0", paddingLeft: 20 }}>
            {importWarnings.warnings.map((w, i) => <li key={i}>{w}</li>)}
          </ul>
          <button
            onClick={() => navigate(`/projects/${importWarnings.projectId}`)}
            style={{ background: "#d97706", color: "#fff", border: "none", padding: "6px 14px", borderRadius: 5, cursor: "pointer", fontSize: 13 }}
          >
            View Merged Project
          </button>
        </div>
      )}

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
