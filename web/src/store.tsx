import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  type Dispatch,
  type ReactNode,
} from "react";
import * as api from "./api";
import { clock } from "./format";
import { useSettings } from "./settings";
import { finalSpec, mergeSpec, type ListField, type TextField } from "./spec";
import type { Agent, Context, Plan, RunEvent, Spec } from "./types";

export type Stage = "brief" | "planning" | "build" | "standup";
export type RunState = "idle" | "running" | "done" | "stopped" | "error";

type EntryBody =
  | { kind: "say"; who: "user" | "max"; text: string }
  | { kind: "log"; at: number; step: string; message: string; speak: boolean }
  | { kind: "note"; tone: "info" | "error"; text: string };
export type Entry = EntryBody & { id: number };

export type State = {
  stage: Stage;
  backend: "checking" | "ok" | "down";
  context: Context | null;
  spec: Partial<Spec>;
  /** Spec fields the founder edited by hand. They outrank Max's final version. */
  specEdited: string[];
  thread: Entry[];
  nextId: number;
  runId: string | null;
  run: RunState;
  runStartedAt: number;
  plan: Plan | null;
  agents: Agent[];
  narratingId: number | null;
};

export type Action =
  | { type: "context"; context: Context }
  | { type: "backendChanged" }
  | { type: "backendDown" }
  | { type: "agents"; agents: Agent[] }
  | { type: "callStarted"; kind: "planning" | "standup" }
  | { type: "said"; who: "user" | "max"; text: string }
  | { type: "specPatch"; patch: Record<string, unknown> }
  | { type: "specEdit"; field: TextField | ListField; value: string | string[] }
  | { type: "buildStarted"; runId: string; spec: Spec; at: number }
  | { type: "runEvent"; event: RunEvent; at: number }
  | { type: "runLost" }
  | { type: "stopped"; at: number }
  | { type: "note"; tone: "info" | "error"; text: string }
  | { type: "narrating"; id: number | null }
  | { type: "reset" };

const initial: State = {
  stage: "brief",
  backend: "checking",
  context: null,
  spec: {},
  specEdited: [],
  thread: [],
  nextId: 1,
  runId: null,
  run: "idle",
  runStartedAt: 0,
  plan: null,
  agents: [],
  narratingId: null,
};

function push(state: State, body: EntryBody): State {
  return {
    ...state,
    thread: [...state.thread, { ...body, id: state.nextId }],
    nextId: state.nextId + 1,
  };
}

function upsert(agents: Agent[], agent: Agent): Agent[] {
  return agents.some((a) => a.taskId === agent.taskId)
    ? agents.map((a) => (a.taskId === agent.taskId ? agent : a))
    : [...agents, agent];
}

function applyRunEvent(state: State, event: RunEvent, at: number): State {
  switch (event.type) {
    case "log":
      return push(state, {
        kind: "log",
        at,
        step: event.step,
        message: event.message,
        speak: Boolean(event.speak),
      });
    case "plan":
      return { ...state, plan: event.plan };
    case "agent":
      return { ...state, agents: upsert(state.agents, event.agent) };
    case "done":
      return push(
        { ...state, run: "done", stage: "standup" },
        { kind: "note", tone: "info", text: `Worked for ${clock(at - state.runStartedAt)}` },
      );
    case "error":
      return push({ ...state, run: "error" }, { kind: "note", tone: "error", text: event.message });
  }
}

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "context":
      return { ...state, context: action.context };
    case "backendChanged":
      // A different backend is a different project, so everything starts over.
      return { ...initial, nextId: state.nextId };
    case "backendDown":
      return state.backend === "down" ? state : { ...state, backend: "down" };
    case "agents":
      return { ...state, backend: "ok", agents: action.agents };
    case "callStarted":
      if (action.kind === "standup") return { ...state, stage: "standup" };
      return state.stage === "brief" ? { ...state, stage: "planning" } : state;
    case "said":
      return push(state, { kind: "say", who: action.who, text: action.text });
    case "specPatch":
      return { ...state, spec: mergeSpec(state.spec, action.patch) };
    case "specEdit":
      return {
        ...state,
        spec: { ...state.spec, [action.field]: action.value },
        specEdited: [...new Set([...state.specEdited, action.field])],
      };
    case "buildStarted":
      return {
        ...state,
        stage: "build",
        spec: action.spec,
        runId: action.runId,
        run: "running",
        runStartedAt: action.at,
        plan: null,
      };
    case "runEvent":
      return applyRunEvent(state, action.event, action.at);
    case "runLost":
      if (state.run !== "running") return state;
      return push(
        { ...state, run: "error" },
        { kind: "note", tone: "error", text: "Lost the connection to the run log." },
      );
    case "stopped":
      if (state.run !== "running") return state;
      return push(
        { ...state, run: "stopped" },
        {
          kind: "note",
          tone: "info",
          text: `Stopped after ${clock(action.at - state.runStartedAt)}`,
        },
      );
    case "note":
      return push(state, { kind: "note", tone: action.tone, text: action.text });
    case "narrating":
      return { ...state, narratingId: action.id };
    case "reset":
      return {
        ...initial,
        backend: state.backend,
        context: state.context,
        agents: state.agents,
        nextId: state.nextId,
      };
  }
}

type Store = { state: State; dispatch: Dispatch<Action>; getState: () => State };
const StoreContext = createContext<Store | null>(null);

export function useStore(): Store {
  const store = useContext(StoreContext);
  if (!store) throw new Error("useStore must be used inside StoreProvider");
  return store;
}

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initial);
  const latest = useRef(state);
  latest.current = state;

  // One poll keeps the team board live and doubles as the backend heartbeat.
  const { apiUrl } = useSettings();
  useEffect(() => {
    dispatch({ type: "backendChanged" });
    let alive = true;
    let haveContext = false;
    const tick = async () => {
      try {
        if (!haveContext) {
          const context = await api.getContext();
          haveContext = true;
          if (alive) dispatch({ type: "context", context });
        }
        const agents = await api.getAgents();
        if (alive) dispatch({ type: "agents", agents });
      } catch {
        if (alive) dispatch({ type: "backendDown" });
      }
    };
    tick();
    const timer = setInterval(tick, 2000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [apiUrl]);

  useEffect(() => {
    if (!state.runId) return;
    return api.streamRun(
      state.runId,
      (event) => dispatch({ type: "runEvent", event, at: Date.now() }),
      () => dispatch({ type: "runLost" }),
    );
  }, [state.runId]);

  const getState = useCallback(() => latest.current, []);
  const store = useMemo(() => ({ state, dispatch, getState }), [state, getState]);
  return <StoreContext.Provider value={store}>{children}</StoreContext.Provider>;
}

const reason = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * The three client tools Max can call. Each returns a short string that goes
 * back to the agent, so a failure is something Max can say out loud.
 */
export function useMaxTools() {
  const { dispatch, getState } = useStore();
  return useMemo(
    () => ({
      updateSpec(patch: Record<string, unknown>): string {
        dispatch({ type: "specPatch", patch });
        return "Spec updated.";
      },
      async startBuild(final: Record<string, unknown>): Promise<string> {
        const { spec: draft, specEdited } = getState();
        const spec = finalSpec(draft, final, specEdited);
        try {
          const { runId } = await api.startBuild(spec);
          dispatch({ type: "buildStarted", runId, spec, at: Date.now() });
          return "Build started.";
        } catch (error) {
          const text = `The build did not start: ${reason(error)}`;
          dispatch({ type: "note", tone: "error", text });
          return text;
        }
      },
      async getStandup(): Promise<string> {
        try {
          const { summary, agents } = await api.getStandup();
          dispatch({ type: "agents", agents });
          return summary;
        } catch (error) {
          const text = `The standup could not be loaded: ${reason(error)}`;
          dispatch({ type: "note", tone: "error", text });
          return text;
        }
      },
    }),
    [dispatch, getState],
  );
}

/** Stops the manager run. Running Codevisor sessions are left alone. */
export function useStopRun() {
  const { dispatch } = useStore();
  return async () => {
    try {
      await api.kill();
      dispatch({ type: "stopped", at: Date.now() });
    } catch (error) {
      dispatch({ type: "note", tone: "error", text: `Could not stop the run: ${reason(error)}` });
    }
  };
}
