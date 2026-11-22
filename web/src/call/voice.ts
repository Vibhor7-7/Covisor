import {
  useConversationClientTool,
  useConversationControls,
  useConversationInput,
  useConversationMode,
  useConversationStatus,
} from "@elevenlabs/react";
import { useEffect, useMemo, useRef } from "react";
import { getSettings } from "../settings";
import { useMaxTools, useStore } from "../store";
import { NO_SPECTRUM, type Call, type CallKind } from "./call";

/** A real voice session with the Max agent on ElevenLabs. */
export function useVoiceCall(error: string | null, setError: (error: string | null) => void): Call {
  const { dispatch, getState } = useStore();
  const tools = useMaxTools();
  const controls = useConversationControls();
  const { status } = useConversationStatus();
  const { isSpeaking } = useConversationMode();
  const { isMuted, setMuted } = useConversationInput();
  const pendingKind = useRef<CallKind | null>(null);

  // Names and parameters must match the client tools on the ElevenLabs agent.
  useConversationClientTool("update_spec", (patch: Record<string, unknown>) =>
    tools.updateSpec(patch),
  );
  useConversationClientTool("start_build", (spec: Record<string, unknown>) =>
    tools.startBuild(spec),
  );
  useConversationClientTool("get_standup", () => tools.getStandup());

  // The Standup button should not make the founder ask twice.
  useEffect(() => {
    if (status !== "connected") return;
    if (pendingKind.current === "standup") controls.sendUserMessage("Give me the standup.");
    pendingKind.current = null;
  }, [status, controls]);

  return useMemo<Call>(() => {
    const live = status === "connected";
    return {
      status: live ? "live" : status === "connecting" ? "connecting" : "idle",
      speaking: live && isSpeaking,
      muted: isMuted,
      setMuted,
      error,
      scripted: false,
      async start(kind) {
        setError(null);
        try {
          const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
          stream.getTracks().forEach((track) => track.stop());
        } catch {
          setError("Max can't hear you. Allow microphone access for this page, then try again.");
          return;
        }
        pendingKind.current = kind;
        dispatch({ type: "callStarted", kind });
        controls.startSession({
          agentId: getSettings().agentId,
          dynamicVariables: {
            context_brief: getState().context?.brief ?? "No project context is connected.",
          },
        });
      },
      end: controls.endSession,
      tell: (note) => live && controls.sendContextualUpdate(note),
      spectrum: () =>
        !live
          ? NO_SPECTRUM
          : isSpeaking
            ? controls.getOutputByteFrequencyData()
            : controls.getInputByteFrequencyData(),
    };
  }, [status, isSpeaking, isMuted, setMuted, error, setError, controls, dispatch, getState]);
}
