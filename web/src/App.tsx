import { Lock, ScrollText, Settings, SquarePen } from "lucide-react";
import { useEffect, useState } from "react";
import { useCall } from "./call/call";
import { CallProvider } from "./call/CallProvider";
import { Decisions } from "./components/Decisions";
import { Graph } from "./components/Graph";
import { SettingsDialog } from "./components/Settings";
import { Stage } from "./components/Stage";
import { Narrator } from "./Narrator";
import { StoreProvider, useStore, useStopRun } from "./store";

type View = "graph" | "decisions";

function Shell() {
  const { state, dispatch } = useStore();
  const call = useCall();
  const stop = useStopRun();
  const [transcript, setTranscript] = useState(false);
  const [view, setView] = useState<View>("graph");
  const [settingsOpen, setSettingsOpen] = useState(false);

  const running = state.run === "running";
  const busy = running || call.status !== "idle";

  useEffect(() => {
    if (!running) return;
    const onKey = (event: KeyboardEvent) => {
      // An open dialog gets Esc first.
      if (event.key === "Escape" && !document.querySelector("dialog[open]")) void stop();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [running]);

  const count = (state.spec.decisions?.length ?? 0) + (state.spec.scopeIn?.length ?? 0);

  return (
    <div className="app">
      <header className="toolbar">
        <span className="wordmark">Max</span>
        <h1>{state.spec.title ?? "New plan"}</h1>
        {state.backend !== "ok" && (
          <p className="backend" role="status">
            {state.backend === "down" ? "Backend unreachable. Retrying." : "Connecting to the backend"}
          </p>
        )}
        <button
          className="icon-button"
          onClick={() => dispatch({ type: "reset" })}
          disabled={busy}
          aria-label="New plan"
          title="New plan"
        >
          <SquarePen />
        </button>
        <button
          className="icon-button"
          onClick={() => setTranscript((shown) => !shown)}
          aria-label="Transcript"
          aria-pressed={transcript}
          title="Transcript"
        >
          <ScrollText />
        </button>
        <button
          className="icon-button"
          onClick={() => setSettingsOpen(true)}
          aria-label="Settings"
          title="Settings"
        >
          <Settings />
        </button>
      </header>

      <Stage transcript={transcript} />

      <section className="board" aria-label="Graph and decisions">
        <div className="tabs" role="tablist">
          <button role="tab" aria-selected={view === "graph"} onClick={() => setView("graph")}>
            Graph
          </button>
          <button role="tab" aria-selected={view === "decisions"} onClick={() => setView("decisions")}>
            Decisions
            {count > 0 && <span>{count}</span>}
          </button>
          {state.runId && (
            <span className="badge" title="The spec is locked once the build starts.">
              <Lock />
              Locked
            </span>
          )}
        </div>
        {view === "graph" ? <Graph /> : <Decisions />}
      </section>

      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} busy={busy} />
      <Narrator />
    </div>
  );
}

export default function App() {
  return (
    <StoreProvider>
      <CallProvider>
        <Shell />
      </CallProvider>
    </StoreProvider>
  );
}
