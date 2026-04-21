import { BrowserRouter, Routes, Route, Link } from "react-router-dom";
import Projects from "./pages/Projects";
import ProjectDetail from "./pages/ProjectDetail";
import RunDetail from "./pages/RunDetail";
import Compare from "./pages/Compare";
import NewProject from "./pages/NewProject";
import ProjectAnalyses from "./pages/ProjectAnalyses";
import AnalysisCompare from "./pages/AnalysisCompare";

function App() {
  return (
    <BrowserRouter>
      <div style={{ minHeight: "100vh", background: "#0a0a0a", color: "#e0e0e0" }}>
        <nav
          style={{
            padding: "16px 24px",
            borderBottom: "1px solid #222",
            display: "flex",
            alignItems: "center",
            gap: 24,
          }}
        >
          <Link
            to="/"
            style={{
              color: "#fff",
              textDecoration: "none",
              fontWeight: 700,
              fontSize: 18,
            }}
          >
            Hamsa Eval
          </Link>
          <Link
            to="/"
            style={{ color: "#888", textDecoration: "none", fontSize: 14 }}
          >
            Projects
          </Link>
        </nav>

        <main style={{ padding: "24px", maxWidth: 1200, margin: "0 auto" }}>
          <Routes>
            <Route path="/" element={<Projects />} />
            <Route path="/projects/new" element={<NewProject />} />
            <Route path="/projects/:id" element={<ProjectDetail />} />
            <Route path="/projects/:id/runs/:runId" element={<RunDetail />} />
            <Route path="/projects/:id/compare" element={<Compare />} />
            <Route path="/projects/:id/analyses" element={<ProjectAnalyses />} />
            <Route path="/projects/:id/analyses/compare" element={<AnalysisCompare />} />
          </Routes>
        </main>
      </div>
    </BrowserRouter>
  );
}

export default App;
