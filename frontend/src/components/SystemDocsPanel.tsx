import { useState, useEffect } from "react";
import T from "../theme";
import {
  listSystemDocs,
  createSystemDoc,
  updateSystemDoc,
  deleteSystemDoc,
} from "../api/client";
import type { SystemDocument, DocType } from "../api/client";

const DOC_TYPES: { value: DocType; label: string }[] = [
  { value: "DESCRIPTION", label: "Description" },
  { value: "CODE_SNIPPET", label: "Code / Variable Setter" },
  { value: "DATA_FLOW", label: "Data Flow" },
  { value: "ERROR_CODES", label: "Error Codes" },
];

interface Props {
  projectId: string;
}

export default function SystemDocsPanel({ projectId }: Props) {
  const [docs, setDocs] = useState<SystemDocument[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);

  const [newName, setNewName] = useState("");
  const [newDocType, setNewDocType] = useState<DocType>("DESCRIPTION");
  const [newContent, setNewContent] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [editFields, setEditFields] = useState<Record<string, { name: string; docType: DocType; content: string }>>({});

  useEffect(() => {
    listSystemDocs(projectId)
      .then(setDocs)
      .catch(() => setError("Failed to load system documents"))
      .finally(() => setLoading(false));
  }, [projectId]);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!newName.trim() || !newContent.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const doc = await createSystemDoc(projectId, { name: newName, docType: newDocType, content: newContent });
      setDocs((d) => [...d, doc]);
      setNewName(""); setNewContent(""); setNewDocType("DESCRIPTION"); setShowNew(false);
    } catch (err: any) {
      setError(err.message || "Failed to create document");
    } finally {
      setSaving(false);
    }
  }

  async function handleUpdate(docId: string) {
    const fields = editFields[docId];
    if (!fields) return;
    setSaving(true);
    setError(null);
    try {
      await updateSystemDoc(projectId, docId, fields);
      setDocs((d) => d.map((doc) => doc.id === docId ? { ...doc, ...fields } : doc));
      setEditingId(null);
    } catch (err: any) {
      setError(err.message || "Failed to update document");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(docId: string) {
    if (!confirm("Delete this document?")) return;
    try {
      await deleteSystemDoc(projectId, docId);
      setDocs((d) => d.filter((doc) => doc.id !== docId));
    } catch (err: any) {
      setError(err.message || "Failed to delete");
    }
  }

  function startEdit(doc: SystemDocument) {
    setEditingId(doc.id);
    setEditFields((f) => ({ ...f, [doc.id]: { name: doc.name, docType: doc.docType, content: doc.content } }));
  }

  const inputStyle: React.CSSProperties = {
    background: T.input, border: `1px solid ${T.border}`, borderRadius: 6,
    padding: "8px 12px", fontSize: 13, color: T.text, width: "100%", boxSizing: "border-box",
  };
  const btnStyle: React.CSSProperties = {
    background: T.primary, color: T.primaryText, border: "none", borderRadius: 6,
    padding: "7px 14px", fontSize: 13, cursor: "pointer", fontWeight: 500,
  };

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <h3 style={{ margin: 0, fontSize: 15, fontWeight: 600, color: T.text }}>System Architecture Docs</h3>
        <button style={{ ...btnStyle, fontSize: 12 }} onClick={() => setShowNew(true)}>+ Add Doc</button>
      </div>

      {error && <div style={{ color: "#ef4444", fontSize: 12, marginBottom: 12 }}>{error}</div>}

      {loading ? (
        <div style={{ color: T.textMuted, fontSize: 13 }}>Loading…</div>
      ) : docs.length === 0 && !showNew ? (
        <div style={{ color: T.textMuted, fontSize: 13, textAlign: "center", padding: "24px 0" }}>
          No system documents yet. Add your agent's variable setter code, API schema, and data flow here.
        </div>
      ) : null}

      {docs.map((doc) => (
        <div key={doc.id} style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 8, padding: 16, marginBottom: 12 }}>
          {editingId === doc.id ? (
            <div>
              <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
                <input
                  style={{ ...inputStyle, flex: 1 }}
                  value={editFields[doc.id]?.name ?? doc.name}
                  onChange={(e) => setEditFields((f) => ({ ...f, [doc.id]: { ...f[doc.id], name: e.target.value } }))}
                  placeholder="Document name"
                />
                <select
                  style={{ ...inputStyle, width: "auto" }}
                  value={editFields[doc.id]?.docType ?? doc.docType}
                  onChange={(e) => setEditFields((f) => ({ ...f, [doc.id]: { ...f[doc.id], docType: e.target.value as DocType } }))}
                >
                  {DOC_TYPES.map((dt) => <option key={dt.value} value={dt.value}>{dt.label}</option>)}
                </select>
              </div>
              <textarea
                style={{ ...inputStyle, minHeight: 120, resize: "vertical", fontFamily: "monospace", fontSize: 12 }}
                value={editFields[doc.id]?.content ?? doc.content}
                onChange={(e) => setEditFields((f) => ({ ...f, [doc.id]: { ...f[doc.id], content: e.target.value } }))}
                maxLength={8000}
              />
              <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                <button style={btnStyle} onClick={() => handleUpdate(doc.id)} disabled={saving}>Save</button>
                <button style={{ ...btnStyle, background: T.card, color: T.textSecondary, border: `1px solid ${T.border}` }} onClick={() => setEditingId(null)}>Cancel</button>
              </div>
            </div>
          ) : (
            <div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                <div>
                  <span style={{ fontWeight: 600, fontSize: 13, color: T.text }}>{doc.name}</span>
                  <span style={{ marginLeft: 8, fontSize: 11, background: T.cardAlt, color: T.textSecondary, borderRadius: 4, padding: "2px 6px" }}>
                    {DOC_TYPES.find((d) => d.value === doc.docType)?.label ?? doc.docType}
                  </span>
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <button style={{ ...btnStyle, background: "transparent", color: T.textMuted, border: "none", padding: "4px 8px", fontSize: 12 }} onClick={() => startEdit(doc)}>Edit</button>
                  <button style={{ ...btnStyle, background: "transparent", color: "#ef4444", border: "none", padding: "4px 8px", fontSize: 12 }} onClick={() => handleDelete(doc.id)}>Delete</button>
                </div>
              </div>
              <pre style={{ margin: "10px 0 0", fontSize: 12, color: T.textSecondary, whiteSpace: "pre-wrap", wordBreak: "break-word", background: T.input, borderRadius: 6, padding: "10px 12px", maxHeight: 200, overflow: "auto" }}>
                {doc.content}
              </pre>
            </div>
          )}
        </div>
      ))}

      {showNew && (
        <form onSubmit={handleCreate} style={{ background: T.card, border: `1px solid ${T.primary}`, borderRadius: 8, padding: 16, marginTop: 8 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: T.text, marginBottom: 12 }}>New Document</div>
          <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
            <input
              style={{ ...inputStyle, flex: 1 }}
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Name (e.g. 'seat_class Variable Setter')"
              required
            />
            <select style={{ ...inputStyle, width: "auto" }} value={newDocType} onChange={(e) => setNewDocType(e.target.value as DocType)}>
              {DOC_TYPES.map((dt) => <option key={dt.value} value={dt.value}>{dt.label}</option>)}
            </select>
          </div>
          <textarea
            style={{ ...inputStyle, minHeight: 140, resize: "vertical", fontFamily: "monospace", fontSize: 12 }}
            value={newContent}
            onChange={(e) => setNewContent(e.target.value)}
            placeholder="Paste code, schema, or description here…"
            maxLength={8000}
            required
          />
          <div style={{ fontSize: 11, color: T.textMuted, marginTop: 4 }}>{newContent.length}/8000 chars</div>
          <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
            <button type="submit" style={btnStyle} disabled={saving}>{saving ? "Saving…" : "Add Document"}</button>
            <button type="button" style={{ ...btnStyle, background: T.card, color: T.textSecondary, border: `1px solid ${T.border}` }} onClick={() => setShowNew(false)}>Cancel</button>
          </div>
        </form>
      )}
    </div>
  );
}
