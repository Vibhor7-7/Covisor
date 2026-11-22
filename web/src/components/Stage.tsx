import { Mic, MicOff, PhoneOff, Square, Volume2, VolumeX } from "lucide-react";
import { useEffect, useState } from "react";
import { useCall } from "../call/call";
import { clock, plural } from "../format";
import { updateSettings, useSettings } from "../settings";
import { useStore, useStopRun } from "../store";
import { Blob } from "./Blob";
import { Thread } from "./Thread";

type Caption = { label: string; text: string; tone?: "quiet" | "error" };

/** One line that says what is happening right now, so nobody needs the transcript. */
function useCaption(): Caption {
  const { state } = useStore();
  const call = useCall();
  const running = state.run === "running";

  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);

  const last = state.thread.at(-1);
  if (call.error) return { label: "", text: call.error, tone: "error" };
  if (running) {
    const worked = clock(Math.max(now, state.runStartedAt) - state.runStartedAt);
    return {
      label: `Max is driving · ${worked} · Esc to stop`,
      text: last?.kind === "log" ? last.message : last?.kind === "say" ? last.text : "",
    };
  }
  if (call.status === "connecting") return { label: "Connecting", text: "" };
  if (call.status === "live") {
    return {
      label: call.speaking ? "Max" : call.muted ? "Your mic is muted" : "Listening",
      text: last?.kind === "say" ? last.text : "",
      tone: last?.kind === "say" && last.who === "user" ? "quiet" : undefined,
    };
  }
  if (!last) {
    const { context } = state;
    if (!context) {
      const text =
        state.backend === "down"
          ? "Max can't reach the backend, so there is no project context yet."
          : "Loading your project context.";
      return { label: "", text, tone: "quiet" };
    }
    const read = [
      context.linear.length > 0 && plural(context.linear.length, "open Linear issue"),
      context.meeting && `your last meeting, ${context.meeting.title}`,
    ].filter(Boolean);
    return {
      label: "",
      text: read.length
        ? `Max has read ${read.join(" and ")}.`
        : "No Linear issues or meeting notes are connected yet.",
      tone: "quiet",
    };
  }
  if (last.kind === "note") {
    return last.tone === "error"
      ? { label: "", text: last.text, tone: "error" }
      : { label: last.text, text: state.run === "done" ? "Ask Max for a standup." : "" };
  }
  return { label: "", text: last.kind === "say" ? last.text : last.message, tone: "quiet" };
}

function Controls() {
  const { state } = useStore();
  const call = useCall();
  const stop = useStopRun();
  const { narration } = useSettings();

  if (state.run === "running") {
    return (
      <div className="controls">
        <button
          className="icon-button"
          onClick={() => updateSettings({ narration: !narration })}
          aria-label={narration ? "Mute narration" : "Unmute narration"}
          aria-pressed={!narration}
        >
          {narration ? <Volume2 /> : <VolumeX />}
        </button>
        <button className="button" onClick={stop}>
          <Square />
          Stop
        </button>
      </div>
    );
  }

  if (call.status !== "idle") {
    return (
      <div className="controls">
        <button
          className="icon-button"
          onClick={() => call.setMuted(!call.muted)}
          aria-label={call.muted ? "Unmute your mic" : "Mute your mic"}
          aria-pressed={call.muted}
        >
          {call.muted ? <MicOff /> : <Mic />}
        </button>
        <button className="button" onClick={call.end}>
          <PhoneOff />
          End call
        </button>
      </div>
    );
  }

  const canStandup = state.agents.length > 0;
  const standupFirst = canStandup && state.stage === "standup";
  return (
    <div className="controls">
      <button
        className={`button ${standupFirst ? "" : "is-primary"}`}
        onClick={() => call.start("planning")}
      >
        <Mic />
        Talk to Max
      </button>
      {canStandup && (
        <button
          className={`button ${standupFirst ? "is-primary" : ""}`}
          onClick={() => call.start("standup")}
        >
          Standup
        </button>
      )}
    </div>
  );
}

/** Max's presence: the blob and one caption, or the full transcript. */
export function Stage({ transcript }: { transcript: boolean }) {
  const { state } = useStore();
  const call = useCall();
  const caption = useCaption();
  const fresh = state.thread.length === 0 && call.status === "idle";

  return (
    <section className="stage" aria-label="Max">
      {transcript ? (
        <Thread />
      ) : (
        <>
          <Blob />
          <div className="caption" aria-live="polite">
            {fresh && <h2>What are we building?</h2>}
            {caption.label && <p className="caption-label">{caption.label}</p>}
            {/* Keyed so each new line fades in instead of swapping in place. */}
            <p className={`caption-text ${caption.tone ? `is-${caption.tone}` : ""}`} key={caption.text}>
              {caption.text}
            </p>
          </div>
        </>
      )}
      <Controls />
      {call.scripted && fresh && !transcript && (
        <p className="hint">No ElevenLabs agent is set, so this plays a scripted call.</p>
      )}
    </section>
  );
}
