// Run registry + per-run event bus. Shared seam between manager, dispatcher, status and the SSE route.
// Every emitted event is kept in history so a late SSE subscriber gets a full replay.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { RUNS_DIR } from "./config";
import type { RunEvent } from "./types";

// Distributive Omit so each RunEvent variant keeps its own fields.
type WithoutTs<T> = T extends unknown ? Omit<T, "ts"> : never;
export type RunEventInput = WithoutTs<RunEvent>;

type Listener = (e: RunEvent) => void;

const history = new Map<string, RunEvent[]>();
const listeners = new Map<string, Set<Listener>>();
const LATEST_FILE = join(RUNS_DIR, "latest");

export function newRunId(): string {
  const d = new Date();
  const stamp = d.toISOString().replace(/[-:T]/g, "").slice(0, 14);
  return `run_${stamp}_${Math.random().toString(36).slice(2, 6)}`;
}

export function runDir(runId: string): string {
  return join(RUNS_DIR, runId);
}

export function createRun(runId: string): string {
  const dir = runDir(runId);
  mkdirSync(join(dir, "tasks"), { recursive: true });
  writeFileSync(LATEST_FILE, runId);
  history.set(runId, []);
  return dir;
}

/** Most recent run id, surviving server restarts (read from runs/latest). */
export function latestRunId(): string | null {
  try {
    return existsSync(LATEST_FILE) ? readFileSync(LATEST_FILE, "utf8").trim() || null : null;
  } catch {
    return null;
  }
}

function eventsFile(runId: string): string {
  return join(runDir(runId), "events.jsonl");
}

/** Load a past run's events from disk (used after a server restart). */
function loadHistory(runId: string): RunEvent[] | null {
  if (!/^[\w-]+$/.test(runId)) return null; // no path traversal via the URL param
  try {
    const raw = readFileSync(eventsFile(runId), "utf8");
    const events = raw
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as RunEvent);
    const finished = events.some((e) => e.type === "done" || e.type === "error");
    if (!finished) {
      events.push({ type: "error", ts: new Date().toISOString(), message: "Run was interrupted (server restarted)." });
    }
    return events;
  } catch {
    return null;
  }
}

export function emit(runId: string, event: RunEventInput): RunEvent {
  const full = { ...event, ts: new Date().toISOString() } as RunEvent;
  if (!history.has(runId)) history.set(runId, []);
  history.get(runId)!.push(full);
  try {
    if (existsSync(runDir(runId))) appendFileSync(eventsFile(runId), JSON.stringify(full) + "\n");
  } catch {
    /* persistence is best effort */
  }
  for (const l of listeners.get(runId) ?? []) {
    try {
      l(full);
    } catch {
      /* a broken listener must not break the run */
    }
  }
  return full;
}

export function isFinished(runId: string): boolean {
  const h = history.get(runId) ?? [];
  return h.some((e) => e.type === "done" || e.type === "error");
}

/** Replays history, then yields live events until a done/error event. */
export async function* streamRun(runId: string): AsyncGenerator<RunEvent> {
  if (!history.has(runId)) {
    // Not in memory: replay from disk if it's a past run, otherwise it's unknown.
    const past = loadHistory(runId);
    if (past) {
      yield* past;
    } else {
      yield { type: "error", ts: new Date().toISOString(), message: `Unknown run: ${runId}` };
    }
    return;
  }
  const queue: RunEvent[] = [...(history.get(runId) ?? [])];
  let wake: (() => void) | null = null;
  const listener: Listener = (e) => {
    queue.push(e);
    wake?.();
  };
  if (!listeners.has(runId)) listeners.set(runId, new Set());
  listeners.get(runId)!.add(listener);
  try {
    while (true) {
      while (queue.length) {
        const e = queue.shift()!;
        yield e;
        if (e.type === "done" || e.type === "error") return;
      }
      await new Promise<void>((r) => (wake = r));
      wake = null;
    }
  } finally {
    listeners.get(runId)?.delete(listener);
  }
}
