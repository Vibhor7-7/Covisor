import {
  useConversationClientTool,
  useConversationControls,
  useConversationInput,
  useConversationMode,
  useConversationStatus,
} from "@elevenlabs/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { getSettings } from "../settings";
import { useMaxTools, useStore } from "../store";
import type { Call, CallKind } from "./call";

/**
 * Max's voice as a stream. The SDK plays the agent through a hidden <audio>
 * element it adds to the page, and that element's source is the stream.
 */
function agentVoice(): MediaStream | null {
  for (const element of document.querySelectorAll<HTMLAudioElement>("body > audio")) {
    if (element.srcObject instanceof MediaStream) return element.srcObject;
  }
  return null;
}

/** A real voice session with the Max agent on ElevenLabs. */
export function useVoiceCall(error: string | null, setError: (error: string | null) => void): Call {
  const { dispatch, getState } = useStore();
  const tools = useMaxTools();
  const controls = useConversationControls();
  const { status } = useConversationStatus();
  const { isSpeaking } = useConversationMode();
  const { isMuted, setMuted } = useConversationInput();
  const pendingKind = useRef<CallKind | null>(null);
  const [microphone, setMicrophone] = useState<MediaStream | null>(null);

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

  // A second, analysis-only tap on the microphone for the length of the call,
  // so the blob can follow the founder while Max listens.
  useEffect(() => {
    if (status !== "connected") return;
    let stream: MediaStream | null = null;
    let over = false;
    navigator.mediaDevices
      .getUserMedia({ audio: true })
      .then((opened) => {
        if (over) return opened.getTracks().forEach((track) => track.stop());
        stream = opened;
        setMicrophone(opened);
      })
      .catch(() => {});
    return () => {
      over = true;
      stream?.getTracks().forEach((track) => track.stop());
      setMicrophone(null);
    };
  }, [status]);

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
      sound: !live ? null : isSpeaking ? agentVoice() : isMuted ? null : microphone,
    };
  }, [status, isSpeaking, isMuted, setMuted, microphone, error, setError, controls, dispatch, getState]);
}
