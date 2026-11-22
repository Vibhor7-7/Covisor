import { useEffect, useRef } from "react";
import * as api from "./api";
import * as audio from "./audio";
import { useCall } from "./call/call";
import { useSettings } from "./settings";
import { useStore } from "./store";

type Line = { id: number; clip: Promise<Blob | null> };

/**
 * Speaks the log lines marked `speak`. Lines play one at a time in order, wait
 * for the call with Max to end, and are dropped while narration is muted.
 */
export function Narrator() {
  const { state, dispatch } = useStore();
  const call = useCall();
  const queue = useRef<Line[]>([]);
  const busy = useRef(false);
  const seen = useRef(0);

  const muted = !useSettings().narration;
  const onCall = call.status !== "idle";
  const flags = useRef({ muted, onCall });
  flags.current = { muted, onCall };

  const pump = useRef(async () => {
    if (busy.current || flags.current.onCall) return;
    const line = queue.current.shift();
    if (!line) return;
    busy.current = true;
    const clip = await line.clip;
    if (clip && !flags.current.muted) {
      dispatch({ type: "narrating", id: line.id });
      await audio.play(clip).catch((error) => console.warn("Narration failed:", error));
      dispatch({ type: "narrating", id: null });
    }
    busy.current = false;
    void pump.current();
  });

  const silence = () => {
    queue.current = [];
    audio.stop();
  };

  // Fetch audio as soon as a line arrives so playback has no gap.
  useEffect(() => {
    for (const entry of state.thread) {
      if (entry.id <= seen.current) continue;
      seen.current = entry.id;
      if (entry.kind !== "log" || !entry.speak || muted) continue;
      queue.current.push({
        id: entry.id,
        clip: api.tts(entry.message).catch((error) => {
          console.warn("Narration unavailable:", error);
          return null;
        }),
      });
    }
    void pump.current();
  }, [state.thread, muted]);

  useEffect(() => {
    if (!onCall) void pump.current();
  }, [onCall]);

  useEffect(() => {
    if (muted || state.run === "stopped" || state.run === "idle") silence();
  }, [muted, state.run]);

  useEffect(() => silence, []);

  return null;
}
