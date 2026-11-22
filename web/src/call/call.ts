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
  /** Frequency data for whoever is talking now. Empty when there is none. */
  spectrum: () => Uint8Array;
};

export const CallContext = createContext<Call | null>(null);

export function useCall(): Call {
  const call = useContext(CallContext);
  if (!call) throw new Error("useCall must be used inside a call provider");
  return call;
}

export const NO_SPECTRUM = new Uint8Array(0);
