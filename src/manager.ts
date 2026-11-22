// OWNER: manager agent (B2 manager run + B5 kill switch).
//
// POST /api/build -> startBuild(spec): writes runs/<runId>/spec.json, spawns a headless `claude -p`
// manager that reads the repo and writes runs/<runId>/plan.json, streams its progress as `log`
// events, validates the plan, emits a `plan` event, hands it to dispatchPlan(), then emits `done`.
// POST /api/kill -> killRun(): stops the manager process group and dispatch, emits "Stopped by user."
//
// Sandbox: cwd is the run dir; built-in tools are limited to Read/Write/Glob/Grep; reads are allowed
// only under the repo (`Read(//<repo>/**)`) and the run dir; writes are auto-accepted only inside the
// run dir (acceptEdits + cwd). Anything else would need an approval, and `--permission-prompts none`
// denies it. No Bash, so no git and no network beyond the optional Linear MCP.
//
// Linear: the backend always puts the Linear issues and meeting from getContext() into the prompt.
// mcp.json (Linear's remote MCP with `Authorization: Bearer ${LINEAR_API_KEY}`) is passed only when
// LINEAR_API_KEY is set and MANAGER_LINEAR_MCP != "0"; otherwise the manager runs without MCP.
//
// Env knobs (all optional): MANAGER_MODEL (via config), CLAUDE_BIN (default "claude"),
// MANAGER_LINEAR_MCP=0, MANAGER_EFFORT (low|medium|high|xhigh|max), MANAGER_MAX_BUDGET_USD,
// MANAGER_TIMEOUT_MS (default 600000), MANAGER_DISPATCH=off (skip dispatch, for testing),
// MANAGER_KEEP_API_KEY=1 (pass ANTHROPIC_API_KEY through to the child; stripped by default because a
// stale key in the shell overrides the claude.ai login and fails with 401).
import { existsSync, readFileSync, realpathSync, statSync, writeFileSync, type WriteStream, createWriteStream } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { Subprocess } from "bun";
import { config, ROOT } from "./config";
import { createRun, emit, newRunId, type RunEventInput } from "./runs";
import { dispatchPlan, stopDispatch } from "./dispatch";
import { getContext } from "./context";
import { StreamJsonParser, type ManagerResult } from "./stream-json";
import type { ContextResponse, ModelChoice, Plan, PlanTask, Spec } from "./types";

const env = process.env;
const CLAUDE_BIN = env.CLAUDE_BIN || "claude";
const PROMPT_FILE = join(ROOT, "manager_prompt.md");
const MCP_FILE = join(ROOT, "mcp.json");
const TIMEOUT_MS = Number(env.MANAGER_TIMEOUT_MS) > 0 ? Number(env.MANAGER_TIMEOUT_MS) : 10 * 60_000;
const PLAN_POLL_MS = 400;
const POST_PLAN_GRACE_MS = 20_000; // manager should stop after writing the plan; stop it if it lingers
const CONTEXT_TIMEOUT_MS = 5_000;
const BLOCKED_LINE =
  "If you need anything from a human (keys, decisions), write BLOCKED.md explaining what and stop.";

// Env vars a parent Claude Code / Codevisor session leaks into children. Left in place they make the
// child think it is nested; ANTHROPIC_API_KEY overrides the user's claude.ai login.
const STRIP_ENV = [
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_SESSION_ATTENDED",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
  "CLAUDE_CODE_EXECPATH",
  "CLAUDE_CODE_CHILD_NOTES_DIR",
  "CLAUDE_PID",
  "CLAUDE_EFFORT",
  // Backend secrets the manager never needs.
  "CODEVISOR_TOKEN",
  "ELEVENLABS_API_KEY",
];

type LogInput = Extract<RunEventInput, { type: "log" }>;

type ActiveRun = {
  runId: string;
  dir: string;
  planPath: string;
  proc: Subprocess<"pipe", "pipe", "pipe"> | null;
  exited: boolean;
  finished: boolean; // done/error emitted
  stopped: boolean; // killed by user or superseded
  planAccepted: boolean;
  lastPlanRaw: string | null;
  lastPlanError: string;
  planCheck: Promise<void>;
  timers: Array<ReturnType<typeof setTimeout>>;
  log: WriteStream | null;
  parser: StreamJsonParser;
  result: ManagerResult | null;
};

let active: ActiveRun | null = null;

// ---------------------------------------------------------------------------------------------
// Public API

export async function startBuild(input: Spec): Promise<{ runId: string }> {
  const { spec, note } = normalizeSpec(input);

  if (active && !active.finished) {
    try {
      stopDispatch();
    } catch {}
    stopRun(active, "Superseded by a new build.");
  }

  const runId = newRunId();
  const dir = createRun(runId);
  writeFileSync(join(dir, "spec.json"), JSON.stringify(spec, null, 2) + "\n");

  const repoRoots = uniq([spec.repoPath, safeRealpath(spec.repoPath)]);
  const run: ActiveRun = {
    runId,
    dir,
    planPath: join(dir, "plan.json"),
    proc: null,
    exited: false,
    finished: false,
    stopped: false,
    planAccepted: false,
    lastPlanRaw: null,
    lastPlanError: "",
    planCheck: Promise.resolve(),
    timers: [],
    log: null,
    parser: new StreamJsonParser({ repoRoots, runDir: dir }),
    result: null,
  };
  active = run;

  say(run, { step: "context", message: `Got the spec: ${spec.title}. Pulling context.` });
  if (note) say(run, { step: "context", message: note });

  void runManager(run, spec).catch((err) => finish(run, "error", `Manager failed: ${errMsg(err)}`));
  return { runId };
}

export function killRun(): { ok: true } {
  try {
    stopDispatch();
  } catch {}
  const run = active;
  if (run && !run.finished) stopRun(run, "Stopped by user.");
  return { ok: true };
}

// ---------------------------------------------------------------------------------------------
// Run lifecycle

async function runManager(run: ActiveRun, spec: Spec): Promise<void> {
  const ctx = await loadContext();
  if (run.finished) return;
  narrateContext(run, ctx);

  const useMcp = linearMcpUsable();
  const prompt = buildPrompt(run, spec, ctx, useMcp);
  const args = buildArgs(spec.repoPath, useMcp);

  run.log = createWriteStream(join(run.dir, "manager.log"), { flags: "a" });
  run.log.write(`# ${new Date().toISOString()} ${[CLAUDE_BIN, ...args].join(" ")}\n`);

  let proc: Subprocess<"pipe", "pipe", "pipe">;
  try {
    proc = Bun.spawn([CLAUDE_BIN, ...args], {
      cwd: run.dir,
      env: childEnv(),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      detached: true, // own process group, so kill reaches anything it spawns
    });
  } catch (err) {
    finish(run, "error", `Could not start the manager (${CLAUDE_BIN}): ${errMsg(err)}`);
    return;
  }
  run.proc = proc;
  if (run.finished) {
    // Killed while we were fetching context or spawning.
    killChild(run);
    return;
  }
  trackChild(proc);

  proc.stdin.write(prompt);
  proc.stdin.end();

  run.timers.push(
    setInterval(() => void checkPlan(run), PLAN_POLL_MS),
    setTimeout(() => {
      if (run.finished || run.planAccepted) return;
      killChild(run);
      finish(run, "error", `Manager timed out after ${Math.round(TIMEOUT_MS / 1000)}s without a plan.`);
    }, TIMEOUT_MS),
  );

  await Promise.all([
    readLines(proc.stdout, (line) => onStdoutLine(run, line)),
    readLines(proc.stderr, (line) => run.log?.write(`[stderr] ${line}\n`)),
    proc.exited,
  ]);
  run.exited = true;
  untrackChild(proc);
  run.log?.write(`# exited code=${proc.exitCode} signal=${proc.signalCode ?? ""}\n`);
  run.log?.end();
  run.log = null;

  if (run.finished || run.stopped) return;
  await checkPlan(run, true);
  if (run.planAccepted || run.finished) return;

  const why = run.result?.isError && run.result.text
    ? run.result.text
    : run.lastPlanError
      ? `plan.json is invalid (${run.lastPlanError})`
      : `no plan.json written (exit code ${proc.exitCode ?? proc.signalCode})`;
  finish(run, "error", `Manager stopped without a valid plan: ${why}`);
}

function onStdoutLine(run: ActiveRun, line: string): void {
  run.log?.write(line + "\n");
  if (run.finished) return;
  const parsed = run.parser.parseLine(line);
  for (const e of parsed.events) say(run, e, false);
  if (parsed.result) run.result = parsed.result;
  // A tool result may be the plan landing on disk: check right away instead of waiting for the poll.
  if (!run.planAccepted && line.includes('"tool_result"')) void checkPlan(run);
}

/** Serialized plan check: read, parse (retrying partial writes on the next tick), validate, accept. */
function checkPlan(run: ActiveRun, final = false): Promise<void> {
  run.planCheck = run.planCheck.then(() => {
    if (run.planAccepted || run.finished) return;
    let raw: string;
    try {
      raw = readFileSync(run.planPath, "utf8");
    } catch {
      return; // not written yet
    }
    if (raw === run.lastPlanRaw && !final) return;
    run.lastPlanRaw = raw;
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch (err) {
      run.lastPlanError = `not valid JSON: ${errMsg(err)}`; // likely a partial write; retried next tick
      return;
    }
    const res = normalizePlan(json, run.runId);
    if (!res.ok) {
      run.lastPlanError = res.error;
      return;
    }
    acceptPlan(run, res.plan, raw, JSON.stringify(json) !== JSON.stringify(res.plan));
  });
  return run.planCheck;
}

function acceptPlan(run: ActiveRun, plan: Plan, raw: string, repaired: boolean): void {
  run.planAccepted = true;
  if (repaired) {
    // Keep disk and the plan event in sync for other modules that read plan.json.
    try {
      writeFileSync(join(run.dir, "plan.raw.json"), raw);
      writeFileSync(run.planPath, JSON.stringify(plan, null, 2) + "\n");
    } catch {}
  }
  emit(run.runId, { type: "plan", plan });
  say(run, { step: "plan", message: staffingLine(plan), speak: true });

  // The manager is told to stop after writing; don't let it linger.
  run.timers.push(
    setTimeout(() => {
      if (!run.exited) killChild(run);
    }, POST_PLAN_GRACE_MS),
  );
  void runDispatch(run, plan);
}

async function runDispatch(run: ActiveRun, plan: Plan): Promise<void> {
  if (run.finished) return;
  let ok = true;
  if (env.MANAGER_DISPATCH === "off" || env.MANAGER_DISPATCH === "0") {
    ok = false;
    say(run, { step: "codevisor", message: "Dispatch skipped (MANAGER_DISPATCH=off)." });
  } else {
    try {
      await dispatchPlan(run.runId, plan);
    } catch (err) {
      ok = false;
      say(run, { step: "codevisor", message: `Dispatch failed: ${errMsg(err)}` });
    }
  }
  if (run.finished) return; // killed during dispatch
  // dispatchPlan reports launch failures as log events, so count what actually started.
  const started = ok ? countSessions(run.dir) : 0;
  say(run, {
    step: "codevisor",
    message:
      started > 0
        ? `Handoff done. ${started} agent${started === 1 ? " is" : "s are"} working in Codevisor.`
        : "The plan is ready, but no agents were started.",
    speak: true,
  });
  finish(run, "done");
}

/** Number of launched sessions in runs/<runId>/sessions.json ({ taskId: sessionId }). */
function countSessions(dir: string): number {
  try {
    const s = JSON.parse(readFileSync(join(dir, "sessions.json"), "utf8")) as Record<string, unknown>;
    return Object.values(s).filter((v) => typeof v === "string" && v).length;
  } catch {
    return 0;
  }
}

function stopRun(run: ActiveRun, message: string): void {
  run.stopped = true;
  killChild(run);
  say(run, { step: "stop", message, speak: true });
  finish(run, "done");
}

/** Emit the terminal event once, clear timers, and stop a manager that is still running. */
function finish(run: ActiveRun, kind: "done" | "error", message = ""): void {
  if (run.finished) return;
  run.finished = true;
  for (const t of run.timers) {
    clearTimeout(t);
    clearInterval(t);
  }
  run.timers = [];
  if (!run.exited) killChild(run);
  if (kind === "error") emit(run.runId, { type: "error", message });
  else emit(run.runId, { type: "done" });
  if (active === run) active = null;
}

/** Emit a log event for a live run. `throttle` lets backend narration count toward the speak budget. */
function say(run: ActiveRun, e: Omit<LogInput, "type">, throttle = true): void {
  if (run.finished) return;
  if (throttle && e.speak) run.parser.noteSpoken(e.step);
  emit(run.runId, { type: "log", ...e });
}

// ---------------------------------------------------------------------------------------------
// Child process handling

const liveChildren = new Set<Subprocess>();
let exitHooksInstalled = false;

function signalGroup(proc: Subprocess, sig: NodeJS.Signals): void {
  try {
    process.kill(-proc.pid, sig); // detached: pid is the process group id
  } catch {
    try {
      proc.kill(sig);
    } catch {}
  }
}

function killChild(run: ActiveRun): void {
  const proc = run.proc;
  if (!proc || run.exited || proc.exitCode !== null || proc.signalCode) return;
  signalGroup(proc, "SIGTERM");
  const t = setTimeout(() => {
    if (proc.exitCode === null && !proc.signalCode) signalGroup(proc, "SIGKILL");
  }, 3000);
  t.unref?.();
}

/** Make sure a detached manager never outlives the server (Ctrl-C, bun --watch restarts). */
function trackChild(proc: Subprocess): void {
  liveChildren.add(proc);
  if (exitHooksInstalled) return;
  exitHooksInstalled = true;
  const killAll = () => {
    for (const p of liveChildren) signalGroup(p, "SIGTERM");
  };
  process.on("exit", killAll);
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(sig, () => {
      killAll();
      // Only take over shutdown if nobody else is handling this signal.
      if (process.listenerCount(sig) <= 1) process.exit(128 + ({ SIGHUP: 1, SIGINT: 2, SIGTERM: 15 } as const)[sig]);
    });
  }
}

function untrackChild(proc: Subprocess): void {
  liveChildren.delete(proc);
}

function childEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined) out[k] = v;
  for (const k of STRIP_ENV) delete out[k];
  if (env.MANAGER_KEEP_API_KEY !== "1") delete out.ANTHROPIC_API_KEY;
  return out;
}

async function readLines(stream: ReadableStream<Uint8Array>, onLine: (line: string) => void): Promise<void> {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let buf = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, "");
        buf = buf.slice(nl + 1);
        if (line) onLine(line);
      }
    }
    buf += dec.decode();
    if (buf.trim()) onLine(buf);
  } catch {
    /* stream torn down by a kill */
  } finally {
    try {
      reader.releaseLock();
    } catch {}
  }
}

// ---------------------------------------------------------------------------------------------
// Command line and prompt

function linearMcpUsable(): boolean {
  return Boolean(env.LINEAR_API_KEY?.trim()) && env.MANAGER_LINEAR_MCP !== "0" && existsSync(MCP_FILE);
}

/** The exact `claude` argv (no shell; the prompt goes in on stdin). */
export function buildArgs(repoPath: string, useMcp: boolean): string[] {
  const repo = safeRealpath(repoPath);
  // "//abs/path/**" is an absolute-path permission rule ("/x" would be relative to the project).
  const readRules = uniq([repoPath, repo]).map((p) => `Read(/${p.replace(/\/+$/, "")}/**)`);
  const args = [
    "-p",
    "--output-format", "stream-json",
    "--verbose",
    "--model", config.managerModel,
    "--permission-mode", "acceptEdits",
    "--permission-prompts", "none",
    "--tools", "Read,Write,Glob,Grep",
    "--allowedTools", ...readRules, ...(useMcp ? ["mcp__linear"] : []),
    "--strict-mcp-config",
    ...(useMcp ? ["--mcp-config", MCP_FILE] : []),
    "--no-session-persistence",
    "--disable-slash-commands",
  ];
  const effort = env.MANAGER_EFFORT?.trim();
  if (effort) args.push("--effort", effort);
  const budget = Number(env.MANAGER_MAX_BUDGET_USD);
  if (budget > 0) args.push("--max-budget-usd", String(budget));
  return args;
}

function buildPrompt(run: ActiveRun, spec: Spec, ctx: ContextResponse | null, useMcp: boolean): string {
  let base = "";
  try {
    base = readFileSync(PROMPT_FILE, "utf8").trim();
  } catch {
    base = "You are the engineering manager. Write PLAN_PATH as a JSON plan for the spec, then stop.";
  }
  const lines: string[] = [
    base,
    "",
    "---",
    `RUN_ID: ${run.runId}`,
    `RUN_DIR: ${run.dir}`,
    `PLAN_PATH: ${run.planPath}`,
    `REPO: ${spec.repoPath}`,
    `LINEAR_MCP: ${useMcp ? "available (mcp__linear__* tools)" : "not available; use the Linear issues under CONTEXT"}`,
    "",
    "CONTEXT (fetched by the backend from Linear and the last meeting):",
  ];
  if (ctx?.brief?.trim()) lines.push(`Brief: ${ctx.brief.trim()}`);
  if (ctx?.linear?.length) {
    lines.push("Open Linear issues:");
    for (const i of ctx.linear.slice(0, 15)) {
      const pr = typeof i.priority === "number" && i.priority > 0 ? `, priority ${i.priority}` : "";
      lines.push(`- ${i.key} [${i.state}${pr}] ${i.title}`);
    }
  } else {
    lines.push("Open Linear issues: none available.");
  }
  if (ctx?.meeting) {
    lines.push(`Last meeting: ${ctx.meeting.title} (${ctx.meeting.date})`, ctx.meeting.summary.trim());
  } else {
    lines.push("Last meeting: none available.");
  }
  lines.push("", "SPEC:", JSON.stringify(spec, null, 2));
  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------------------------
// Context

async function loadContext(): Promise<ContextResponse | null> {
  try {
    return await Promise.race([
      getContext(),
      new Promise<null>((r) => setTimeout(() => r(null), CONTEXT_TIMEOUT_MS)),
    ]);
  } catch {
    return null;
  }
}

function narrateContext(run: ActiveRun, ctx: ContextResponse | null): void {
  const issues = ctx?.linear ?? [];
  if (issues.length) {
    const keys = issues.slice(0, 4).map((i) => i.key).join(", ");
    const more = issues.length > 4 ? ` and ${issues.length - 4} more` : "";
    say(run, {
      step: "context",
      message: `Reading Linear: ${issues.length} open issue${issues.length === 1 ? "" : "s"} (${keys}${more}).`,
      speak: true,
    });
  }
  if (ctx?.meeting) say(run, { step: "context", message: `Last meeting: ${ctx.meeting.title} (${ctx.meeting.date}).` });
  if (!issues.length && !ctx?.meeting) {
    say(run, { step: "context", message: "No Linear or meeting context connected. Planning from the spec and the repo." });
  }
}

// ---------------------------------------------------------------------------------------------
// Validation

function normalizeSpec(input: Spec): { spec: Spec; note: string } {
  const raw = (input ?? {}) as Partial<Record<keyof Spec, unknown>>;
  const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const list = (v: unknown): string[] =>
    Array.isArray(v)
      ? v.map((x) => (typeof x === "string" ? x.trim() : x == null ? "" : JSON.stringify(x))).filter(Boolean)
      : text(v)
        ? [text(v)]
        : [];

  const title = text(raw.title);
  if (!title) throw new Error("Spec needs a title");

  let note = "";
  let repoPath = text(raw.repoPath);
  if (!repoPath) {
    repoPath = config.demoRepo;
  } else if (!isDir(repoPath) && config.demoRepo && isDir(config.demoRepo)) {
    // The voice agent fills repoPath itself and can invent one; the demo repo is the safe target.
    note = `Repo path ${repoPath} not found; using the demo repo.`;
    repoPath = config.demoRepo;
  }
  if (!repoPath) throw new Error("Spec needs a repoPath (and DEMO_REPO is not set)");
  if (!isAbsolute(repoPath) || !isDir(repoPath)) throw new Error(`Repo path is not a directory: ${repoPath}`);
  repoPath = repoPath.replace(/\/+$/, "");

  return {
    note,
    spec: {
      title,
      goal: text(raw.goal),
      user: text(raw.user),
      scopeIn: list(raw.scopeIn),
      scopeOut: list(raw.scopeOut),
      decisions: list(raw.decisions),
      constraints: list(raw.constraints),
      acceptance: list(raw.acceptance),
      openQuestions: list(raw.openQuestions),
      repoPath,
    },
  };
}

/** Coerce the manager's plan into the Plan contract, repairing what is safe to repair. */
export function normalizePlan(json: unknown, runId: string): { ok: true; plan: Plan } | { ok: false; error: string } {
  const tasksField = typeof json === "object" && json !== null ? (json as { tasks?: unknown }).tasks : undefined;
  const rawTasks: unknown[] | null = Array.isArray(json) ? json : Array.isArray(tasksField) ? tasksField : null;
  if (!rawTasks) return { ok: false, error: "missing tasks array" };

  const text = (v: unknown) => (typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "");
  const list = (v: unknown): string[] =>
    Array.isArray(v) ? v.map(text).filter(Boolean) : text(v) ? [text(v)] : [];

  const tasks: PlanTask[] = [];
  const seen = new Set<string>();
  rawTasks.forEach((t, i) => {
    if (typeof t !== "object" || t === null) return;
    const r = t as Record<string, unknown>;
    let title = text(r.title);
    let prompt = text(r.prompt);
    if (!title && !prompt) return; // nothing to hand an agent
    if (!title) title = prompt.split("\n")[0]!.slice(0, 80);
    const acceptance = list(r.acceptance);
    if (!prompt) prompt = [title, ...acceptance.map((a) => `- ${a}`)].join("\n");
    if (!prompt.includes("BLOCKED.md")) prompt = `${prompt}\n\n${BLOCKED_LINE}`;

    let id = text(r.id) || `t${i + 1}`;
    while (seen.has(id)) id = `${id}_${i + 1}`;
    seen.add(id);

    tasks.push({
      id,
      title,
      prompt,
      acceptance,
      model: coerceModel(r.model),
      reason: text(r.reason),
      dependsOn: list(r.dependsOn),
    });
  });
  if (!tasks.length) return { ok: false, error: "no usable tasks" };

  // Only keep dependencies on tasks that exist (and never on itself).
  const ids = new Set(tasks.map((t) => t.id));
  for (const t of tasks) t.dependsOn = uniq(t.dependsOn.filter((d) => d !== t.id && ids.has(d)));

  return { ok: true, plan: { runId, tasks } };
}

function coerceModel(v: unknown): ModelChoice {
  const s = typeof v === "string" ? v.toLowerCase() : "";
  if (s.includes("opus")) return "opus";
  if (s.includes("local")) return "local";
  return "sonnet";
}

function staffingLine(plan: Plan): string {
  const n = plan.tasks.length;
  const counts: Array<[string, number]> = [
    ["Opus", plan.tasks.filter((t) => t.model === "opus").length],
    ["Sonnet", plan.tasks.filter((t) => t.model === "sonnet").length],
    ["local", plan.tasks.filter((t) => t.model === "local").length],
  ];
  const parts = counts.filter(([, c]) => c > 0).map(([m, c]) => `${c} ${m}`);
  return `Plan ready. Staffed ${n} task${n === 1 ? "" : "s"}: ${parts.join(", ")}.`;
}

// ---------------------------------------------------------------------------------------------
// Small helpers

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function safeRealpath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

function uniq<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
