import { BrowserRouter, Routes, Route, Link, Navigate, useLocation } from "react-router-dom";
import Projects from "./pages/Projects";
import ProjectDetail from "./pages/ProjectDetail";
import RunDetail from "./pages/RunDetail";
import Compare from "./pages/Compare";
import NewProject from "./pages/NewProject";
import ProjectAnalyses from "./pages/ProjectAnalyses";
import AnalysisCompare from "./pages/AnalysisCompare";
import Preview from "./pages/Preview";
import Login from "./pages/Login";
import { AuthProvider, useAuth } from "./context/AuthContext";
import T from "./theme";

function HamsaLogo() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="23" fill="none" viewBox="0 0 48 46">
      <path fill="#17B26A" d="M25.946 44.938c-.664.845-2.021.375-2.021-.698V33.937a2.26 2.26 0 0 0-2.262-2.262H10.287c-.92 0-1.456-1.04-.92-1.788l7.48-10.471c1.07-1.497 0-3.578-1.842-3.578H1.237c-.92 0-1.456-1.04-.92-1.788L10.013.474c.214-.297.556-.474.92-.474h28.894c.92 0 1.456 1.04.92 1.788l-7.48 10.471c-1.07 1.498 0 3.579 1.842 3.579h11.377c.943 0 1.473 1.088.89 1.83L25.947 44.94z" />
    </svg>
  );
}

function RequireAuth({ children }: { children: React.ReactNode }) {
  const { token, initializing } = useAuth();
  const location = useLocation();
  // While the stored token is being verified, render nothing to avoid a
  // login-page flash that immediately redirects back to the original URL.
  if (initializing) return null;
  if (!token) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }
  return <>{children}</>;
}

function NavBar() {
  const { user, logout } = useAuth();
  if (!user) return null;

  return (
    <nav
      style={{
        padding: "12px 24px",
        borderBottom: `1px solid ${T.border}`,
        display: "flex",
        alignItems: "center",
        gap: 20,
        background: T.nav,
        boxShadow: T.shadow,
        position: "sticky",
        top: 0,
        zIndex: 50,
      }}
    >
      <Link
        to="/"
        style={{
          color: T.text,
          textDecoration: "none",
          fontWeight: 700,
          fontSize: 16,
          display: "flex",
          alignItems: "center",
          gap: 8,
        }}
      >
        <HamsaLogo />
        Hamsa Eval
      </Link>
      <Link
        to="/"
        style={{ color: T.textSecondary, textDecoration: "none", fontSize: 14 }}
      >
        Projects
      </Link>

      {/* Spacer */}
      <div style={{ flex: 1 }} />

      {/* User info + logout */}
      <span style={{ fontSize: 13, color: T.textSecondary }}>{user.email}</span>
      <button
        onClick={logout}
        style={{
          fontSize: 13,
          color: T.textSecondary,
          background: "none",
          border: `1px solid ${T.border}`,
          borderRadius: T.radiusSm,
          padding: "5px 12px",
          cursor: "pointer",
        }}
        onMouseEnter={(e) => {
          (e.target as HTMLButtonElement).style.borderColor = T.borderDark;
          (e.target as HTMLButtonElement).style.color = T.text;
        }}
        onMouseLeave={(e) => {
          (e.target as HTMLButtonElement).style.borderColor = T.border;
          (e.target as HTMLButtonElement).style.color = T.textSecondary;
        }}
      >
        Sign out
      </button>
    </nav>
  );
}

function AppShell() {
  const { user } = useAuth();

  return (
    <div style={{ minHeight: "100vh", background: T.bg, color: T.text }}>
      <NavBar />
      <main style={user ? { padding: "24px", maxWidth: 1200, margin: "0 auto" } : {}}>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route
            path="/"
            element={<RequireAuth><Projects /></RequireAuth>}
          />
          <Route
            path="/projects/new"
            element={<RequireAuth><NewProject /></RequireAuth>}
          />
          <Route
            path="/projects/:id"
            element={<RequireAuth><ProjectDetail /></RequireAuth>}
          />
          <Route
            path="/projects/:id/runs/:runId"
            element={<RequireAuth><RunDetail /></RequireAuth>}
          />
          <Route
            path="/projects/:id/compare"
            element={<RequireAuth><Compare /></RequireAuth>}
          />
          <Route
            path="/projects/:id/analyses"
            element={<RequireAuth><ProjectAnalyses /></RequireAuth>}
          />
          <Route
            path="/projects/:id/analyses/compare"
            element={<RequireAuth><AnalysisCompare /></RequireAuth>}
          />
          <Route
            path="/preview"
            element={<RequireAuth><Preview /></RequireAuth>}
          />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}

function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <AppShell />
      </AuthProvider>
    </BrowserRouter>
  );
}

export default App;
