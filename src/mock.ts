// MOCK=1 mode (PRD 4.5, milestone M1). Serves mocks/*.json from the real endpoints and replays
// mocks/run-events.jsonl over SSE. Files are re-read and checked on every request, so edits to a
// mock show up without a restart, and a typo comes back as a clear "mocks/<file>: ..." error.
//
// Replay timing comes from the `ts` gaps in run-events.jsonl (clamped to 0.2-3s). Every replayed
// event is restamped to now, and the plan event's runId is set to the requested runId.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { config, MOCKS_DIR } from "./config";
import { newRunId } from "./runs";
import type { Agent, ContextResponse, Plan, RunEvent, Spec, StandupResponse } from "./types";

const FIRST_GAP_MS = 300;
const MIN_GAP_MS = 200;
const MAX_GAP_MS = 3000;
/** How long ago the most recently active mock agent was active, at request time. */
const NEWEST_AGENT_AGE_MS = 2 * 60_000;

// ---------- loose validation ----------

type Obj = Record<string, unknown>;

class Check {
  constructor(private file: string) {}

  fail(path: string, msg: string): never {
    throw new Error(`mocks/${this.file}: ${path} ${msg}`);
  }

  obj(v: unknown, path: string, required: string[], optional: string[] = []): Obj {
    if (typeof v !== "object" || v === null || Array.isArray(v)) this.fail(path, "must be an object");
    const o = v as Obj;
    for (const k of required) if (!(k in o)) this.fail(path, `is missing "${k}"`);
    for (const k of Object.keys(o)) {
      if (!required.includes(k) && !optional.includes(k)) this.fail(path, `has unknown key "${k}" (typo?)`);
    }
    return o;
  }

  str(v: unknown, path: string): string {
    if (typeof v !== "string") this.fail(path, `must be a string, got ${JSON.stringify(v)}`);
    return v;
  }

  iso(v: unknown, path: string): string {
    const s = this.str(v, path);
    if (Number.isNaN(Date.parse(s))) this.fail(path, `must be an ISO date, got "${s}"`);
    return s;
  }

  arr(v: unknown, path: string): unknown[] {
    if (!Array.isArray(v)) this.fail(path, "must be an array");
    return v;
  }

  strArr(v: unknown, path: string): string[] {
    return this.arr(v, path).map((x, i) => this.str(x, `${path}[${i}]`));
  }

  oneOf(v: unknown, path: string, allowed: readonly string[]): string {
    if (typeof v !== "string" || !allowed.includes(v)) {
      this.fail(path, `must be one of ${allowed.join(" | ")}, got ${JSON.stringify(v)}`);
    }
    return v;
  }
}

const STATUSES = ["queued", "working", "needs_review", "stuck", "done", "error"] as const;
const MODELS = ["opus", "sonnet", "local"] as const;

function checkAgent(c: Check, v: unknown, p: string): Agent {
  const o = c.obj(v, p, ["taskId", "sessionId", "title", "model", "status", "detail", "lastActivityAt"]);
  for (const k of ["taskId", "title", "model", "detail"]) c.str(o[k], `${p}.${k}`);
  if (o.sessionId !== null) c.str(o.sessionId, `${p}.sessionId`);
  c.oneOf(o.status, `${p}.status`, STATUSES);
  c.iso(o.lastActivityAt, `${p}.lastActivityAt`);
  return o as Agent;
}

function checkAgents(c: Check, v: unknown, p: string): Agent[] {
  return c.arr(v, p).map((a, i) => checkAgent(c, a, `${p}[${i}]`));
}

function checkPlan(c: Check, v: unknown, p: string): Plan {
  const o = c.obj(v, p, ["runId", "tasks"]);
  c.str(o.runId, `${p}.runId`);
  const tasks = c.arr(o.tasks, `${p}.tasks`);
  if (tasks.length === 0) c.fail(`${p}.tasks`, "must not be empty");
  const ids = new Set<string>();
  const deps: Array<[string, string[]]> = [];
  tasks.forEach((t, i) => {
    const tp = `${p}.tasks[${i}]`;
    const to = c.obj(t, tp, ["id", "title", "prompt", "acceptance", "model", "reason", "dependsOn"]);
    const id = c.str(to.id, `${tp}.id`);
    if (ids.has(id)) c.fail(`${tp}.id`, `"${id}" is used twice`);
    ids.add(id);
    for (const k of ["title", "prompt", "reason"]) c.str(to[k], `${tp}.${k}`);
    c.strArr(to.acceptance, `${tp}.acceptance`);
    c.oneOf(to.model, `${tp}.model`, MODELS);
    deps.push([tp, c.strArr(to.dependsOn, `${tp}.dependsOn`)]);
  });
  for (const [tp, ds] of deps) {
    for (const d of ds) if (!ids.has(d)) c.fail(`${tp}.dependsOn`, `refers to unknown task "${d}"`);
  }
  return o as Plan;
}

function checkContext(c: Check, v: unknown): ContextResponse {
  const o = c.obj(v, "root", ["brief", "linear", "meeting"]);
  c.str(o.brief, "brief");
  c.arr(o.linear, "linear").forEach((issue, i) => {
    const p = `linear[${i}]`;
    const io = c.obj(issue, p, ["id", "key", "title", "state"], ["priority"]);
    for (const k of ["id", "key", "title", "state"]) c.str(io[k], `${p}.${k}`);
    if (io.priority !== undefined && typeof io.priority !== "number") c.fail(`${p}.priority`, "must be a number");
  });
  if (o.meeting !== null) {
    const m = c.obj(o.meeting, "meeting", ["title", "date", "summary"]);
    for (const k of ["title", "date", "summary"]) c.str(m[k], `meeting.${k}`);
  }
  return o as ContextResponse;
}

function checkStandup(c: Check, v: unknown): StandupResponse {
  const o = c.obj(v, "root", ["summary", "agents"]);
  c.str(o.summary, "summary");
  checkAgents(c, o.agents, "agents");
  return o as StandupResponse;
}

function checkRunEvent(c: Check, v: unknown, p: string): RunEvent {
  const type = c.obj(v, p, ["type"], ["ts", "step", "message", "speak", "plan", "agent"]).type;
  switch (type) {
    case "log": {
      const o = c.obj(v, p, ["type", "ts", "step", "message"], ["speak"]);
      c.str(o.step, `${p}.step`);
      c.str(o.message, `${p}.message`);
      if (o.speak !== undefined && typeof o.speak !== "boolean") c.fail(`${p}.speak`, "must be a boolean");
      break;
    }
    case "plan":
      checkPlan(c, c.obj(v, p, ["type", "ts", "plan"]).plan, `${p}.plan`);
      break;
    case "agent":
      checkAgent(c, c.obj(v, p, ["type", "ts", "agent"]).agent, `${p}.agent`);
      break;
    case "done":
      c.obj(v, p, ["type", "ts"]);
      break;
    case "error":
      c.str(c.obj(v, p, ["type", "ts", "message"]).message, `${p}.message`);
      break;
    default:
      c.fail(`${p}.type`, `must be log | plan | agent | done | error, got ${JSON.stringify(type)}`);
  }
  c.iso((v as Obj).ts, `${p}.ts`);
  return v as RunEvent;
}

// ---------- loading ----------

function readText(file: string): string {
  try {
    return readFileSync(join(MOCKS_DIR, file), "utf8");
  } catch (err) {
    throw new Error(`mocks/${file}: cannot read (${err instanceof Error ? err.message : String(err)})`);
  }
}

function parse(file: string, text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`mocks/${file}: invalid JSON (${err instanceof Error ? err.message : String(err)})`);
  }
}

function load<T>(file: string, check: (c: Check, v: unknown) => T): T {
  return check(new Check(file), parse(file, readText(file)));
}

const loadContext = () => load("context.json", checkContext);
const loadPlan = () => load("plan.json", (c, v) => checkPlan(c, v, "plan"));
const loadAgents = () => load("agents.json", (c, v) => checkAgents(c, v, "agents"));
const loadStandup = () => load("standup.json", checkStandup);

function loadEvents(): RunEvent[] {
  const file = "run-events.jsonl";
  const events: RunEvent[] = [];
  readText(file)
    .split("\n")
    .forEach((line, i) => {
      if (!line.trim()) return;
      const where = `${file} line ${i + 1}`;
      events.push(checkRunEvent(new Check(where), parse(where, line), "event"));
    });
  const last = events.at(-1);
  if (!last || (last.type !== "done" && last.type !== "error")) {
    new Check(file).fail("last event", "must be a done or error event, or the stream never ends");
  }
  return events;
}

/** Shift timestamps so the most recent agent was active NEWEST_AGENT_AGE_MS ago ("last active 2m ago"). */
function rebaseActivity(agents: Agent[]): Agent[] {
  const times = agents.map((a) => Date.parse(a.lastActivityAt));
  if (times.length === 0) return agents;
  const shift = Date.now() - NEWEST_AGENT_AGE_MS - Math.max(...times);
  return agents.map((a, i) => ({ ...a, lastActivityAt: new Date(times[i]! + shift).toISOString() }));
}

function replayGaps(events: RunEvent[]): number[] {
  return events.map((e, i) => {
    if (i === 0) return FIRST_GAP_MS;
    const gap = Date.parse(e.ts) - Date.parse(events[i - 1]!.ts);
    return Math.min(MAX_GAP_MS, Math.max(MIN_GAP_MS, gap));
  });
}

// ---------- endpoints ----------
// mockContext/mockAgents/mockStandup are deliberately not `async`: a bad mock file throws synchronously,
// which Elysia's onError turns into a JSON 500. index.ts routes of the form `() => (m ? a() : b())` are not
// detected as async by Elysia, so a rejected promise there skips onError and Bun serves an HTML error page.

export function mockContext(): Promise<ContextResponse> {
  return Promise.resolve(loadContext());
}

export async function mockStartBuild(spec: Spec): Promise<{ runId: string }> {
  const required: Array<keyof Spec> = [
    "title", "goal", "user", "scopeIn", "scopeOut", "decisions", "constraints", "acceptance", "openQuestions", "repoPath",
  ];
  const missing = required.filter((k) => spec?.[k] === undefined);
  if (missing.length) console.warn(`[mock] spec is missing fields: ${missing.join(", ")} (accepted anyway)`);
  const runId = newRunId();
  console.log(`[mock] build ${runId} started: "${spec?.title ?? "(untitled)"}"`);
  return { runId };
}

type Replay = { killed: boolean; wake: (() => void) | null };
const replays = new Set<Replay>();

function sleep(ms: number, r: Replay): Promise<void> {
  if (r.killed) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      r.wake = null;
      resolve();
    };
    const timer = setTimeout(finish, ms);
    r.wake = finish;
  });
}

function restamp(e: RunEvent, runId: string): RunEvent {
  const ts = new Date().toISOString();
  switch (e.type) {
    case "plan":
      return { ...e, ts, plan: { ...e.plan, runId } };
    case "agent":
      return { ...e, ts, agent: { ...e.agent, lastActivityAt: ts } };
    default:
      return { ...e, ts };
  }
}

export async function* mockRunEvents(runId: string): AsyncGenerator<RunEvent> {
  const events = loadEvents();
  const gaps = replayGaps(events);
  const r: Replay = { killed: false, wake: null };
  replays.add(r);
  try {
    for (let i = 0; i < events.length; i++) {
      await sleep(gaps[i]!, r);
      if (r.killed) {
        // Mirrors PRD B5: final "Stopped by user." log, then end the stream.
        yield { type: "log", ts: new Date().toISOString(), step: "manager", message: "Stopped by user.", speak: true };
        yield { type: "done", ts: new Date().toISOString() };
        return;
      }
      yield restamp(events[i]!, runId);
    }
  } finally {
    r.wake?.();
    replays.delete(r);
  }
}

export function mockAgents(): Promise<Agent[]> {
  return Promise.resolve(rebaseActivity(loadAgents()));
}

export function mockStandup(): Promise<StandupResponse> {
  const s = loadStandup();
  return Promise.resolve({ summary: s.summary, agents: rebaseActivity(s.agents) });
}

/** Stops any mock replay in progress (it ends with "Stopped by user." then done). */
export function mockKill(): { ok: true } {
  for (const r of replays) {
    r.killed = true;
    r.wake?.();
  }
  return { ok: true };
}

// ---------- startup check (MOCK=1 only): report every broken file and any drift between files ----------

function startupCheck(): void {
  const errors: string[] = [];
  const attempt = <T>(fn: () => T): T | undefined => {
    try {
      return fn();
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
      return undefined;
    }
  };
  const ctx = attempt(loadContext);
  const plan = attempt(loadPlan);
  const agents = attempt(loadAgents);
  const standup = attempt(loadStandup);
  const events = attempt(loadEvents);
  for (const e of errors) console.error(`[mock] ERROR ${e}`);

  const warn = (msg: string) => console.warn(`[mock] warning: ${msg}`);
  const key = (as: Agent[]) => as.map((a) => `${a.taskId}:${a.status}:${a.detail}`).sort().join("|");
  if (plan && events) {
    const p = events.find((e) => e.type === "plan");
    const strip = (x: Plan) => JSON.stringify(x.tasks);
    if (!p) warn("run-events.jsonl has no plan event");
    else if (strip(p.plan) !== strip(plan)) warn("plan event in run-events.jsonl differs from plan.json");
  }
  if (agents && standup && key(agents) !== key(standup.agents)) {
    warn("standup.json agents differ from agents.json (taskId/status/detail)");
  }
  if (plan && agents) {
    const ids = new Set(plan.tasks.map((t) => t.id));
    for (const a of agents) if (!ids.has(a.taskId)) warn(`agents.json taskId "${a.taskId}" is not in plan.json`);
  }
  if (ctx && plan && agents && events) {
    const secs = replayGaps(events).reduce((a, b) => a + b, 0) / 1000;
    console.log(
      `[mock] mocks OK: ${ctx.linear.length} issues, ${plan.tasks.length} tasks, ${agents.length} agents, ` +
        `${events.length} run events (~${secs.toFixed(1)}s replay)`,
    );
  }
}

if (config.mock) startupCheck();
