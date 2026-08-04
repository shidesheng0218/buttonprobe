import { useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Activity,
  Archive,
  CheckCircle2,
  Clock3,
  FileText,
  RefreshCw,
  Rocket,
  Save,
  Settings,
  Trash2,
  TriangleAlert
} from "lucide-react";
import "./styles.css";

function App() {
  const [lastSync, setLastSync] = useState("18:40");
  const [logsOpen, setLogsOpen] = useState(false);
  const [activeSection, setActiveSection] = useState("Overview");

  return (
    <div className="shell">
      <aside>
        <div className="brand"><Rocket size={18} /> Release Console</div>
        <nav>
          <div className="nav-active nav-static" title="Overview">
            <Activity size={17} /><span className="nav-label">Overview</span>
          </div>
          <button
            title="Activity logs"
            onClick={() => { setActiveSection("Activity logs"); setLogsOpen((value) => !value); }}
          >
            <FileText size={17} /><span className="nav-label">Activity logs</span>
          </button>
          <button title="Archives" onClick={() => setActiveSection("Archives")}>
            <Archive size={17} /><span className="nav-label">Archives</span>
          </button>
          <button title="Settings" onClick={() => setActiveSection("Settings")}>
            <Settings size={17} /><span className="nav-label">Settings</span>
          </button>
        </nav>
        <div className="environment"><span className="status-dot" /> Production</div>
      </aside>

      <main>
        <header>
          <div>
            <p className="eyebrow">Workspace / Atlas / {activeSection}</p>
            <h1>{activeSection === "Overview" ? "Release readiness" : activeSection}</h1>
          </div>
          <button
            className="icon-button"
            data-testid="refresh-status"
            aria-label="Refresh status"
            title="Refresh status"
            onClick={() => setLastSync(new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }))}
          >
            <RefreshCw size={18} />
          </button>
        </header>

        <section className="metrics">
          <article><span>Checks passed</span><strong>18 / 20</strong><CheckCircle2 size={20} /></article>
          <article><span>Open blockers</span><strong>2</strong><TriangleAlert size={20} /></article>
          <article><span>Last sync</span><strong>{lastSync}</strong><Clock3 size={20} /></article>
        </section>

        <section className="release-panel">
          <div className="panel-heading">
            <div>
              <h2>Atlas 2.8.0</h2>
              <p>Scheduled for July 30, 2026 at 21:00</p>
            </div>
            <span className="pending">Needs review</span>
          </div>

          <div className="check-row">
            <CheckCircle2 size={18} />
            <div><strong>Build artifacts</strong><span>Verified 14 minutes ago</span></div>
            <span>Passed</span>
          </div>
          <div className="check-row warning">
            <TriangleAlert size={18} />
            <div><strong>Migration smoke test</strong><span>One retry required</span></div>
            <span>Review</span>
          </div>

          {logsOpen ? (
            <div className="logs" role="region" aria-label="Activity logs">
              <code>18:39:52 deployment.preview completed</code>
              <code>18:40:03 checks.accessibility passed</code>
            </div>
          ) : null}

          <footer>
            <button className="secondary" data-testid="save-draft" onClick={() => {}}>
              <Save size={17} /> Save draft
            </button>
            <button
              className="secondary"
              data-testid="preview-release"
              onClick={() => {
                throw new Error("Preview service is unavailable");
              }}
            >
              Preview release
            </button>
            <button className="danger" data-testid="delete-release">
              <Trash2 size={17} /> Delete release
            </button>
          </footer>
        </section>
      </main>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
