// OWNER: dispatcher agent. Small typed client for the Codevisor HTTP API routes dispatch needs.
// See docs/codevisor-cli.md for the exact calls. The token is only ever sent as a header, never logged.
import { realpathSync } from "node:fs";
import { basename } from "node:path";
import { config } from "./config";
import type { ModelChoice } from "./types";

const DEFAULT_TIMEOUT_MS = 15_000;
const EXCERPT_CHARS = 300;

export const CLAUDE_CODE = "claude-code";

/** Plan model -> claude-code model id (the `model` config option on a session). Overridable per env. */
export const MODEL_IDS: Record<ModelChoice, string> = {
  opus: process.env.CODEVISOR_MODEL_OPUS || "claude-opus-5-5",
  sonnet: process.env.CODEVISOR_MODEL_SONNET || "claude-sonnet-5-5",
  // No local harness is ready on this machine, so "local" falls back to Sonnet.
  local: process.env.CODEVISOR_MODEL_LOCAL || "claude-sonnet-5-5",
};

/** Spoken name for a claude-code model id: "claude-sonnet-5-5" -> "Sonnet". */
export function modelLabel(modelId: string): string {
  const family = modelId.replace(/^claude-/, "").split("-")[0] ?? modelId;
  return family.charAt(0).toUpperCase() + family.slice(1);
}

// ---- Types (subset of the OpenAPI schemas we use) ----

export type ProjectLocation = {
  id: string;
  projectId: string;
  serverId: string;
  folderPath: string;
  isGitRepository?: boolean | null;
  createdAt: string;
};

export type Project = {
  id: string;
  name: string;
  origin: string;
  createdAt: string;
  locations: ProjectLocation[];
  isBot?: boolean | null;
  isScratch?: boolean | null;
};

export type Worktree = {
  id: string;
  projectId: string;
  serverId: string;
  name: string;
  branch: string;
  path: string;
  createdAt: string;
};

/** Codevisor's own session state (sidebar state). */
export type SidebarState = "idle" | "inProgress" | "waitingForUser" | "unread" | "errored";

export type Session = {
  id: string;
  projectId: string;
  harnessId: string;
  title: string;
  worktreeName?: string | null;
  workspaceId?: string | null;
  cwd?: string | null;
  checkoutId?: string | null;
  configSelections?: Record<string, string> | null;
  unavailableConfigSelections?: Record<string, string> | null;
  labels?: Record<string, string> | null;
  createdAt: string;
  updatedAt?: string | null;
  sidebarState?: SidebarState | null;
  sidebarStateChangedAt?: string | null;
  actionRequired?: boolean | null;
  actionRequiredKind?: "question" | "approval" | "planApproval" | null;
  hasUnreadError?: boolean | null;
  latestBotMessage?: { text: string } | null;
};

export type PromptResult = {
  accepted: boolean;
  sessionId: string;
  queueItemId?: string | null;
  delivered?: "sent" | "steered" | "queued" | null;
};

export type StartAgentResult = {
  agentId: string;
  title: string;
  projectId: string;
  workspaceId?: string | null;
  worktreeName?: string | null;
  delivered?: string | null;
  subscribed: boolean;
};

// ---- HTTP core ----

export class CodevisorError extends Error {
  constructor(
    message: string,
    public readonly status: number | null,
    public readonly method: string,
    public readonly path: string,
  ) {
    super(message);
    this.name = "CodevisorError";
  }
}

function redact(text: string): string {
  const t = config.codevisorToken;
  return t ? text.split(t).join("***") : text;
}

function excerpt(text: string): string {
  const flat = redact(text).replace(/\s+/g, " ").trim();
  return flat.length > EXCERPT_CHARS ? `${flat.slice(0, EXCERPT_CHARS)}...` : flat;
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<T> {
  const url = config.codevisorUrl.replace(/\/+$/, "") + path;
  const headers: Record<string, string> = { accept: "application/json" };
  if (config.codevisorToken) headers.authorization = `Bearer ${config.codevisorToken}`;
  if (body !== undefined) headers["content-type"] = "application/json";

  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const e = err as Error;
    const why =
      e?.name === "TimeoutError" || e?.name === "AbortError"
        ? `timed out after ${timeoutMs} ms`
        : `request failed (${excerpt(e?.message ?? String(err))})`;
    throw new CodevisorError(`Codevisor ${method} ${path} ${why}. Is the server running?`, null, method, path);
  }

  const text = await res.text().catch(() => "");
  if (!res.ok) {
    throw new CodevisorError(
      `Codevisor ${method} ${path} -> HTTP ${res.status}: ${excerpt(text) || res.statusText}`,
      res.status,
      method,
      path,
    );
  }
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new CodevisorError(
      `Codevisor ${method} ${path} -> HTTP ${res.status} but the body is not JSON: ${excerpt(text)}`,
      res.status,
      method,
      path,
    );
  }
}

const enc = encodeURIComponent;

// ---- Health ----

export function health(): Promise<{ ok: boolean; version: string }> {
  return request("GET", "/v1/health", undefined, 5_000);
}

// ---- Projects ----

function normalizePath(p: string): string {
  let out = p;
  try {
    out = realpathSync(p);
  } catch {
    /* path may not exist on this machine; compare as given */
  }
  return out.replace(/\/+$/, "") || "/";
}

export function listProjects(): Promise<Project[]> {
  return request("GET", "/v1/projects");
}

/** Exact folder-path match (a project at a parent folder does not count). */
export async function findProjectByPath(folderPath: string): Promise<Project | null> {
  const want = normalizePath(folderPath);
  const projects = await listProjects();
  return (
    projects.find((p) => !p.isBot && p.locations.some((l) => normalizePath(l.folderPath) === want)) ?? null
  );
}

export function createProject(folderPath: string, name?: string): Promise<Project> {
  return request("POST", "/v1/projects", { folderPath, name: name ?? basename(folderPath) });
}

const projectCache = new Map<string, Project>();

/** Find the project registered at this folder, or register it. Idempotent. */
export async function ensureProject(folderPath: string, name?: string): Promise<Project> {
  const key = normalizePath(folderPath);
  const cached = projectCache.get(key);
  if (cached) return cached;
  const project = (await findProjectByPath(key)) ?? (await createProject(key, name));
  projectCache.set(key, project);
  return project;
}

// ---- Worktrees ----

export function listWorktrees(projectId: string): Promise<Worktree[]> {
  return request("GET", `/v1/projects/${enc(projectId)}/worktrees`);
}

/** Creates a git worktree for the project (on a new branch). Can take a few seconds. */
export function createWorktree(projectId: string, name: string): Promise<Worktree> {
  return request("POST", `/v1/projects/${enc(projectId)}/worktrees`, { name }, 60_000);
}

// ---- Sessions ----

export type CreateSessionInput = {
  projectId: string;
  harnessId?: string;
  title: string;
  /** Name of an existing worktree of the project; the session runs in it. */
  worktreeName?: string;
  workspaceId?: string;
  /** Model id for the harness, e.g. "claude-sonnet-5-5". Sent as configSelections.model. */
  model?: string;
  labels?: Record<string, string>;
};

export function createSession(input: CreateSessionInput): Promise<Session> {
  const body: Record<string, unknown> = {
    projectId: input.projectId,
    harnessId: input.harnessId ?? CLAUDE_CODE,
    title: input.title,
    createdBy: "user",
  };
  if (input.worktreeName) body.worktreeName = input.worktreeName;
  if (input.workspaceId) body.workspaceId = input.workspaceId;
  if (input.model) body.configSelections = { model: input.model };
  if (input.labels) body.labels = input.labels;
  return request("POST", "/v1/sessions", body, 60_000);
}

/** Sends a user message. On a fresh session this is the first prompt and starts the agent. */
export function sendPrompt(sessionId: string, text: string): Promise<PromptResult> {
  return request("POST", `/v1/sessions/${enc(sessionId)}/prompt`, { text }, 30_000);
}

/** Changes a session config option, e.g. setConfig(id, "model", "claude-opus-5-5"). */
export function setSessionConfig(sessionId: string, configId: string, value: string): Promise<unknown> {
  return request("POST", `/v1/sessions/${enc(sessionId)}/config`, { configId, value });
}

/** Session summary (the `session` field of GET /v1/sessions/{id}). */
export async function getSession(sessionId: string): Promise<Session> {
  const detail = await request<{ session: Session }>("GET", `/v1/sessions/${enc(sessionId)}`);
  return detail.session;
}

export function listSessions(): Promise<Session[]> {
  return request("GET", "/v1/sessions");
}

// ---- One-call agent start (fallback launch path) ----

export type StartAgentInput = {
  projectId: string;
  title: string;
  prompt: string;
  harness?: string;
  model?: string;
  labels?: Record<string, string>;
};

/** POST /v1/agents: new worktree + session + first message in one call (rolls back on failure). */
export function startAgent(input: StartAgentInput): Promise<StartAgentResult> {
  return request(
    "POST",
    "/v1/agents",
    {
      title: input.title,
      prompt: input.prompt,
      checkout: "worktree",
      standalone: true,
      harness: input.harness ?? CLAUDE_CODE,
      model: input.model ?? null,
      project: input.projectId,
      labels: input.labels ?? null,
    },
    120_000,
  );
}
