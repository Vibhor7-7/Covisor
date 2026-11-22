import { asUrl, getSettings } from "./settings";
import type { Agent, Context, RunEvent, Spec } from "./types";

const base = () => asUrl(getSettings().apiUrl);

async function request(path: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(base() + path, init);
  if (!res.ok) throw new Error(`${init?.method ?? "GET"} ${path} returned ${res.status}`);
  return res;
}

const post = (body?: unknown): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: body === undefined ? undefined : JSON.stringify(body),
});

export const getContext = async (): Promise<Context> => (await request("/api/context")).json();
export const getAgents = async (): Promise<Agent[]> => (await request("/api/agents")).json();
export const getStandup = async (): Promise<{ summary: string; agents: Agent[] }> =>
  (await request("/api/standup")).json();
export const startBuild = async (spec: Spec): Promise<{ runId: string }> =>
  (await request("/api/build", post({ spec }))).json();
export const kill = async (): Promise<void> => void (await request("/api/kill", post()));
export const tts = async (text: string): Promise<Blob> =>
  (await request("/api/tts", post({ text }))).blob();

/**
 * Subscribes to a run's event stream. Accepts both unnamed SSE messages and
 * messages named after the event type. Returns an unsubscribe function.
 */
export function streamRun(
  runId: string,
  onEvent: (event: RunEvent) => void,
  onLost: () => void,
): () => void {
  const source = new EventSource(`${base()}/api/runs/${encodeURIComponent(runId)}/stream`);
  const handle = (e: MessageEvent) => {
    const event = JSON.parse(e.data) as RunEvent;
    onEvent(event);
    if (event.type === "done" || event.type === "error") source.close();
  };
  source.onmessage = handle;
  for (const type of ["log", "plan", "agent", "done"]) source.addEventListener(type, handle);
  // A server event named "error" and a dropped connection both arrive here.
  source.onerror = (e) => {
    if (e instanceof MessageEvent && e.data) return handle(e);
    // Closing stops EventSource from reconnecting and replaying the run.
    source.close();
    onLost();
  };
  return () => source.close();
}
