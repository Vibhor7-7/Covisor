import { createContext, useContext } from "react";

export type CallKind = "planning" | "standup";

/** What the UI needs from a voice session, whoever provides it. */
export type Call = {
  status: "idle" | "connecting" | "live";
  /** True while Max is talking. */
  speaking: boolean;
  muted: boolean;
  setMuted: (muted: boolean) => void;
  error: string | null;
  /** True when no ElevenLabs agent is configured and the call is a script. */
  scripted: boolean;
  start: (kind: CallKind) => void;
  end: () => void;
  /** Passes Max a note mid-call without making it reply. */
  tell: (note: string) => void;
  /** Whoever is talking right now, as audio the blob can watch. */
  sound: MediaStream | null;
};

export const CallContext = createContext<Call | null>(null);

export function useCall(): Call {
  const call = useContext(CallContext);
  if (!call) throw new Error("useCall must be used inside a call provider");
  return call;
}
