import { ConversationProvider } from "@elevenlabs/react";
import { useState, type ReactNode } from "react";
import { useSettings } from "../settings";
import { useStore } from "../store";
import { CallContext } from "./call";
import { useScriptedCall } from "./scripted";
import { useVoiceCall } from "./voice";

type Props = { children: ReactNode };

/** Provides the call: a real ElevenLabs session, or the script when no agent is set. */
export function CallProvider({ children }: Props) {
  const { dispatch } = useStore();
  const [error, setError] = useState<string | null>(null);
  return (
    <ConversationProvider
      onMessage={({ message, role }) =>
        dispatch({ type: "said", who: role === "user" ? "user" : "max", text: message })
      }
      onError={(message) => setError(`The call failed: ${message}`)}
    >
      <Pick error={error} setError={setError}>
        {children}
      </Pick>
    </ConversationProvider>
  );
}

function Pick({
  error,
  setError,
  children,
}: Props & { error: string | null; setError: (error: string | null) => void }) {
  const voice = useVoiceCall(error, setError);
  const scripted = useScriptedCall();
  const { agentId } = useSettings();
  return <CallContext.Provider value={agentId ? voice : scripted}>{children}</CallContext.Provider>;
}
