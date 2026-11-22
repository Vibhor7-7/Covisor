// OWNER: dispatcher agent (B2 dispatch via Codevisor).
// For each ready task: write tasks/<id>.md, start a claude-code agent in the demo project on its own
// worktree (and sidebar workspace) with the task as its first message, record sessions.json, and
// emit log + agent events. HTTP calls and their shapes: docs/codevisor-cli.md.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  CodevisorError,
  MODEL_IDS,
  createSession,
  createWorktree,
  ensureProject,
  getSession,
  listWorktrees,
  modelLabel,
  sendPrompt,
  startAgent,
  type Project,
} from "./codevisor";
import { config } from "./config";
import { emit, runDir } from "./runs";
import type { Agent, AgentStatus, Plan, PlanTask } from "./types";

/**
 * Launch path. "agents" (default): POST /v1/agents, one call that creates the worktree, a
 * workspace (so the chat shows in the Codevisor sidebar), the session and its first message.
 * "sessions" (CODEVISOR_LAUNCH=sessions): explicit worktree + session + prompt calls. It names the
 * branch, but the session gets no workspace, so it may not show in the app's sidebar.
 */
const LAUNCH_MODE = process.env.CODEVISOR_LAUNCH === "sessions" ? "sessions" : "agents";

const BLOCKED_LINE =
  "If you need anything from a human (keys, decisions), write BLOCKED.md explaining what and stop.";

// Bumped by stopDispatch(); a dispatch loop stops launching once its generation is stale.
let generation = 0;

export type Launch = {
  taskId: string;
  sessionId: string;
  projectId: string;
  title: string;
  model: string;
  modelId: string;
  worktreeName: string | null;
  branch: string | null;
  worktreePath: string | null;
  workspaceId: string | null;
  via: "sessions" | "agents";
  launchedAt: string;
};

/** Launch every task in the plan with no unmet dependencies as a Codevisor session. Never throws. */
export async function dispatchPlan(runId: string, plan: Plan): Promise<void> {
  const myGen = generation;
  const tasks = plan.tasks ?? [];
  const ids = new Set(tasks.map((t) => t.id));
  const unmetDeps = (t: PlanTask) => (t.dependsOn ?? []).filter((d) => ids.has(d) && d !== t.id);
  const ready = tasks.filter((t) => unmetDeps(t).length === 0);
  const waiting = tasks.filter((t) => unmetDeps(t).length > 0);

  // Show every task on the board right away.
  for (const t of tasks) {
    const deps = unmetDeps(t);
    emitAgent(runId, t, null, "queued", deps.length ? `Waiting on ${deps.join(", ")}` : "Waiting to start");
  }

  // Write every task file first, so long prompts never go through quoting and are inspectable.
  for (const t of tasks) {
    try {
      writeTaskFile(runId, t);
    } catch (err) {
      emit(runId, { type: "log", step: "codevisor", message: `Could not write task file for ${t.id}: ${msg(err)}` });
    }
  }

  if (ready.length === 0) {
    emit(runId, { type: "log", step: "codevisor", message: "No task is ready to start: every task waits on another." });
    return;
  }

  const repo = config.demoRepo || readSpecRepo(runId);
  let project: Project | null = null;
  try {
    if (!repo) throw new Error("DEMO_REPO is not set and the spec has no repoPath");
    project = await ensureProject(repo);
    emit(runId, { type: "log", step: "codevisor", message: `Using Codevisor project ${project.name} (${project.id}).` });
  } catch (err) {
    const why = msg(err);
    emit(runId, { type: "log", step: "codevisor", message: `Could not open the demo repo in Codevisor: ${why}` });
    for (const t of ready) emitAgent(runId, t, null, "error", short(`Not started: ${why}`));
    return;
  }

  let started = 0;
  let failed = 0;
  for (const [i, task] of ready.entries()) {
    if (myGen !== generation) {
      emit(runId, { type: "log", step: "codevisor", message: `Dispatch stopped. ${ready.length - i} task(s) not started.` });
      break;
    }
    const n = i + 1;
    try {
      const launch = await launchTask(runId, project, task);
      started++;
      recordLaunch(runId, launch);
      emit(runId, {
        type: "log",
        step: "codevisor",
        speak: true,
        message: `Started agent ${n} in Codevisor: ${task.title}, on ${modelLabel(launch.modelId)}.`,
      });
      emitAgent(runId, task, launch.sessionId, "working", "Starting");
    } catch (err) {
      failed++;
      const why = msg(err);
      emit(runId, { type: "log", step: "codevisor", message: `Could not start agent ${n} (${task.title}): ${why}` });
      const sid = err instanceof PartialLaunchError ? err.launch.sessionId : null;
      if (err instanceof PartialLaunchError) recordLaunch(runId, err.launch);
      emitAgent(runId, task, sid, "error", short(why));
    }
  }

  const parts = [`${started} started`];
  if (failed) parts.push(`${failed} failed`);
  if (waiting.length) parts.push(`${waiting.length} queued behind dependencies`);
  emit(runId, { type: "log", step: "codevisor", message: `Dispatch finished: ${parts.join(", ")}.` });
}

/** Stop launching further tasks (called by the kill switch). Never touches running sessions. */
export function stopDispatch(): void {
  generation++;
}

// ---- One task ----

class PartialLaunchError extends Error {
  constructor(message: string, public readonly launch: Launch) {
    super(message);
  }
}

type LaunchBase = Pick<Launch, "taskId" | "projectId" | "title" | "model" | "modelId">;
type LaunchInput = { runId: string; task: PlanTask; text: string; labels: Record<string, string>; base: LaunchBase };

/** Creates the worktree + session and sends the first prompt. Throws on failure. */
export async function launchTask(runId: string, project: Project, task: PlanTask): Promise<Launch> {
  const modelId = MODEL_IDS[task.model] ?? MODEL_IDS.sonnet;
  const input: LaunchInput = {
    runId,
    task,
    text: taskMarkdown(task),
    labels: { covisorRun: runId, covisorTask: task.id, covisorModel: task.model },
    base: { taskId: task.id, projectId: project.id, title: task.title, model: task.model, modelId },
  };

  if (LAUNCH_MODE === "sessions") return launchViaSessions(input);

  try {
    return await launchViaAgents(input);
  } catch (err) {
    // No response at all (timeout, server down): the call may have gone through, so don't retry.
    if (!(err instanceof CodevisorError) || err.status === null) throw err;
    emit(runId, {
      type: "log",
      step: "codevisor",
      message: `One-call start failed for ${task.id} (${msg(err)}). Trying worktree + session instead.`,
    });
    try {
      return await launchViaSessions(input);
    } catch (err2) {
      if (err2 instanceof PartialLaunchError) throw err2;
      throw new Error(`${msg(err)} | fallback: ${msg(err2)}`);
    }
  }
}

/** POST /v1/agents (standalone, own worktree + workspace), then best-effort details for status. */
async function launchViaAgents({ task, text, labels, base }: LaunchInput): Promise<Launch> {
  const res = await startAgent({
    projectId: base.projectId,
    title: task.title,
    prompt: text,
    model: base.modelId,
    labels,
  });
  const launch: Launch = {
    ...base,
    sessionId: res.agentId, // agent id == session id
    worktreeName: res.worktreeName ?? null,
    branch: null,
    worktreePath: null,
    workspaceId: res.workspaceId ?? null,
    via: "agents",
    launchedAt: new Date().toISOString(),
  };
  try {
    const s = await getSession(res.agentId);
    launch.worktreeName = s.worktreeName ?? launch.worktreeName;
    launch.worktreePath = s.cwd ?? null;
    launch.workspaceId = s.workspaceId ?? launch.workspaceId;
    if (launch.worktreeName) {
      const wt = (await listWorktrees(base.projectId)).find((w) => w.name === launch.worktreeName);
      launch.branch = wt?.branch ?? null;
      launch.worktreePath = launch.worktreePath ?? wt?.path ?? null;
    }
  } catch {
    /* details are nice to have; the session is already running */
  }
  return launch;
}

/** Explicit path: POST worktree, POST session (model via configSelections), POST prompt. */
async function launchViaSessions({ runId, task, text, labels, base }: LaunchInput): Promise<Launch> {
  const wt = await createTaskWorktree(base.projectId, runId, task.id);
  const session = await createSession({
    projectId: base.projectId,
    title: task.title,
    worktreeName: wt.name,
    model: base.modelId,
    labels,
  });
  const launch: Launch = {
    ...base,
    sessionId: session.id,
    worktreeName: session.worktreeName ?? wt.name,
    branch: wt.branch,
    worktreePath: session.cwd ?? wt.path,
    workspaceId: session.workspaceId ?? null,
    via: "sessions",
    launchedAt: new Date().toISOString(),
  };
  // The session exists now. Send the task; retry once, since the harness may still be booting.
  try {
    await sendPromptWithRetry(launch.sessionId, text);
    return launch;
  } catch (err) {
    throw new PartialLaunchError(`Session ${launch.sessionId} created but the prompt failed: ${msg(err)}`, launch);
  }
}

/** Worktree "agent-<taskId>-<runTag>" (branch becomes codevisor/agent-...); new suffix on a clash. */
async function createTaskWorktree(projectId: string, runId: string, taskId: string) {
  const tag = runId.split("_").pop() || runId;
  const slug = `${taskId}-${tag}`.toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
  // Codevisor rejects "/" in worktree names and prefixes the branch with "codevisor/" itself.
  const candidates = [`agent-${slug}`, `agent-${slug}-${Math.random().toString(36).slice(2, 6)}`];
  let lastErr: unknown;
  for (const name of candidates) {
    try {
      return await createWorktree(projectId, name);
    } catch (err) {
      lastErr = err;
      const status = err instanceof CodevisorError ? err.status : null;
      // Only a rejected or clashing name is worth another try.
      if (status !== 400 && status !== 409 && status !== 422) throw err;
    }
  }
  throw lastErr;
}

async function sendPromptWithRetry(sessionId: string, text: string): Promise<void> {
  try {
    const r = await sendPrompt(sessionId, text);
    if (r && r.accepted === false) throw new Error("prompt not accepted");
  } catch (first) {
    await Bun.sleep(2000);
    const r = await sendPrompt(sessionId, text).catch((e) => {
      throw new Error(`${msg(first)}; retry: ${msg(e)}`);
    });
    if (r && r.accepted === false) throw new Error("prompt not accepted after retry");
  }
}

// ---- Files ----

function taskMarkdown(task: PlanTask): string {
  const lines = [`# ${task.title}`, "", task.prompt.trim(), ""];
  if (task.acceptance?.length) {
    lines.push("## Acceptance criteria", "", ...task.acceptance.map((a) => `- ${a}`), "");
  }
  lines.push("## Ground rules", "");
  lines.push("- Work only in this checkout. Commit your work on the current branch when you finish.");
  lines.push("- Never push, merge, or delete branches.");
  if (!task.prompt.includes("BLOCKED.md")) lines.push(`- ${BLOCKED_LINE}`);
  return lines.join("\n") + "\n";
}

function writeTaskFile(runId: string, task: PlanTask): string {
  const file = join(runDir(runId), "tasks", `${safeName(task.id)}.md`);
  writeFileSync(file, taskMarkdown(task));
  return file;
}

function readJson<T>(file: string, fallback: T): T {
  try {
    return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as T) : fallback;
  } catch {
    return fallback;
  }
}

/** sessions.json is the contract ({ taskId: sessionId }); launches.json adds worktree details for status. */
function recordLaunch(runId: string, launch: Launch): void {
  const dir = runDir(runId);
  try {
    const sessionsFile = join(dir, "sessions.json");
    const sessions = readJson<Record<string, string>>(sessionsFile, {});
    sessions[launch.taskId] = launch.sessionId;
    writeFileSync(sessionsFile, JSON.stringify(sessions, null, 2) + "\n");

    const launchesFile = join(dir, "launches.json");
    const launches = readJson<Record<string, Launch>>(launchesFile, {});
    launches[launch.taskId] = launch;
    writeFileSync(launchesFile, JSON.stringify(launches, null, 2) + "\n");
  } catch (err) {
    emit(runId, { type: "log", step: "codevisor", message: `Could not record session for ${launch.taskId}: ${msg(err)}` });
  }
}

function readSpecRepo(runId: string): string {
  return readJson<{ repoPath?: string }>(join(runDir(runId), "spec.json"), {}).repoPath ?? "";
}

// ---- Helpers ----

function emitAgent(runId: string, task: PlanTask, sessionId: string | null, status: AgentStatus, detail: string) {
  const agent: Agent = {
    taskId: task.id,
    sessionId,
    title: task.title,
    model: task.model,
    status,
    detail,
    lastActivityAt: new Date().toISOString(),
  };
  emit(runId, { type: "agent", agent });
}

function safeName(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]+/g, "_");
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function short(s: string, n = 160): string {
  return s.length > n ? `${s.slice(0, n - 3)}...` : s;
}
