import { Volume2 } from "lucide-react";
import { useEffect, useRef } from "react";
import { clock } from "../format";
import { useStore, type Entry } from "../store";

function Row({ entry, startedAt, narrating }: { entry: Entry; startedAt: number; narrating: boolean }) {
  switch (entry.kind) {
    case "say":
      return <p className={`say is-${entry.who}`}>{entry.text}</p>;
    case "note":
      return <p className={`note is-${entry.tone}`}>{entry.text}</p>;
    case "log":
      return (
        <p className="log">
          <span className="log-step">{entry.step}</span>
          <span>{entry.message}</span>
          <span className="log-time">
            {narrating && <Volume2 aria-label="Being read aloud" />}
            {clock(entry.at - startedAt)}
          </span>
        </p>
      );
  }
}

/** Everything said and done so far: the call, then the run log. */
export function Thread() {
  const { state } = useStore();
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [state.thread.length]);

  return (
    <div className="thread" role="log">
      {state.thread.length === 0 && <p className="empty">Nothing has been said yet.</p>}
      {state.thread.map((entry) => (
        <Row
          key={entry.id}
          entry={entry}
          startedAt={state.runStartedAt}
          narrating={entry.id === state.narratingId}
        />
      ))}
      <div ref={bottom} />
    </div>
  );
}
