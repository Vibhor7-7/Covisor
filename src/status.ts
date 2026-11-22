// OWNER: status agent (B3). Status service behind GET /api/agents and GET /api/standup.
//
// For the latest run (runs/latest, or STATUS_RUN_ID) it returns one Agent per plan task, merging:
//   1. Codevisor session state, GET /v1/sessions field `sidebarState` (primary).
//   2. Codevisor events, /v1/events SSE (secondary): fresher session payloads and last-activity time.
//   3. Git/worktree heuristics (always on): BLOCKED.md, commits vs the base branch, merged branches,
//      uncommitted changes, inactivity.
// A task's worktree is found from the session's `cwd`, else runs/<runId>/launches.json (written by
// the dispatcher: branch, worktreePath, worktreeName), else `git worktree list` by worktree name or
// a branch named after the task. Codevisor names branches codevisor/<worktreeName>.
// Waiting-on-a-question details come from GET /v1/agents/{id} pendingQuestion.
//
// Status rules, first match wins:
//   queued        no session id for the task in sessions.json yet
//   done          the task branch is merged into the base branch (its tip is reachable from base and
//                 either moved since the branch was created, per the branch reflog, or is a parent of
//                 a merge commit on base), or the session is archived in Codevisor
//   stuck         BLOCKED.md in the worktree (detail: its first line), unless the session went back
//                 to inProgress after BLOCKED.md was written
//   With Codevisor state:
//   stuck         sidebarState "waitingForUser", or actionRequired / pendingPlanApproval
//   working       sidebarState "inProgress"; stuck "No activity for N min" after STATUS_STALE_MS of silence
//   error         sidebarState "errored", or the turn ended with lastTurnFailure / hasUnreadError
//   needs_review  sidebarState "idle" / "unread" (turn ended) with commits ahead of base (detail: diff
//                 stat vs base, "+212 -8, 4 files") or uncommitted changes
//   working       idle session that never ran yet (no updatedAt), within STATUS_STALE_MS of launch
//   stuck         idle session with no changes: "Finished with no changes"
//   Without Codevisor state (unknown session id, deleted session, or Codevisor unreachable):
//   working       activity (commit, file change, event) within STATUS_ACTIVE_MS
//   needs_review  commits ahead of base and quiet since
//   working       less than STATUS_STALE_MS since the last activity or launch
//   stuck         "No recent activity"
//
// lastActivityAt = latest of: session event time, last branch commit, session updatedAt /
// sidebarStateChangedAt, changed-file mtimes, BLOCKED.md mtime. Falls back to launch time.
//
// Env knobs (all optional):
//   STATUS_RUN_ID          run to report on instead of runs/latest
//   STATUS_DEMO_REPO       demo repo path (else DEMO_REPO, else the run's spec.json repoPath)
//   STATUS_BASE_BRANCH     base branch (else main, else master, else the repo's HEAD branch)
//   STATUS_STALE_MS        inactivity before an agent counts as stuck (default 600000 = 10 min)
//   STATUS_ACTIVE_MS       "recent activity" window for heuristics (default 120000 = 2 min)
//   STATUS_EVENTS=0        do not start the /v1/events subscriber
//   STATUS_HTTP_TIMEOUT_MS Codevisor HTTP timeout (default 800)
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { config } from "./config";
import { latestRunId, runDir } from "./runs";
import type { Agent, AgentStatus, Plan, PlanTask, StandupResponse } from "./types";
import {
  ensureEventsSubscriber,
  getPendingQuestion,
  getSessionActivity,
  listSessions,
  type CvSession,
  type SessionActivity,
} from "./codevisor-status";

const GIT_TIMEOUT_MS = 1500;

function envMs(name: string, dflt: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}

// ---------------------------------------------------------------------------------------------
// Run files
// ---------------------------------------------------------------------------------------------

const lastGood = new Map<string, unknown>(); // path -> last parsed JSON (survives half-written files)

function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    const v = JSON.parse(readFileSync(path, "utf8")) as T;
    lastGood.set(path, v);
    return v;
  } catch {
    return (lastGood.get(path) as T | undefined) ?? null;
  }
}

function mtimeMs(path: string): number | null {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

function normalizeSessions(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [taskId, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "string" && v) out[taskId] = v;
    else if (v && typeof v === "object") {
      const id = (v as { sessionId?: unknown; id?: unknown }).sessionId ?? (v as { id?: unknown }).id;
      if (typeof id === "string" && id) out[taskId] = id;
    }
  }
  return out;
}

function normalizeTasks(plan: Plan | null): PlanTask[] {
  if (!plan || !Array.isArray(plan.tasks)) return [];
  return plan.tasks
    .filter((t) => t && typeof t === "object" && typeof t.id === "string" && t.id)
    .map((t) => ({
      ...t,
      title: typeof t.title === "string" && t.title.trim() ? t.title.trim() : `Task ${t.id}`,
      model: t.model ?? "sonnet",
      dependsOn: Array.isArray(t.dependsOn) ? t.dependsOn : [],
    }));
}

function resolveRepo(runPath: string): string | null {
  const spec = readJson<{ repoPath?: unknown }>(join(runPath, "spec.json"));
  const candidates = [process.env.STATUS_DEMO_REPO, config.demoRepo, typeof spec?.repoPath === "string" ? spec.repoPath : ""];
  for (const c of candidates) if (c && existsSync(c)) return resolve(c);
  return null;
}

// ---------------------------------------------------------------------------------------------
// Git helpers (never throw; read-only; GIT_OPTIONAL_LOCKS=0 so we never fight an agent for index.lock)
// ---------------------------------------------------------------------------------------------

type GitResult = { ok: boolean; out: string };

async function git(cwd: string, args: string[]): Promise<GitResult> {
  try {
    const proc = Bun.spawn(["git", "-C", cwd, ...args], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
    });
    const timer = setTimeout(() => proc.kill(), GIT_TIMEOUT_MS);
    try {
      const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
      // trimEnd only: porcelain status lines start with a meaningful space (" M file").
      return { ok: code === 0, out: out.trimEnd() };
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return { ok: false, out: "" };
  }
}

type Worktree = { path: string; branch: string | null; external?: boolean };
/** branches: local branch names, newest tip first. */
type RepoCtx = { repo: string; base: string; worktrees: Worktree[]; branches: string[] };

function real(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

function parseWorktrees(out: string): Worktree[] {
  const list: Worktree[] = [];
  let cur: Worktree | null = null;
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) {
      cur = { path: line.slice(9), branch: null };
      list.push(cur);
    } else if (cur && line.startsWith("branch ")) {
      cur.branch = line.slice(7).replace(/^refs\/heads\//, "");
    }
  }
  return list;
}

const baseCache = new Map<string, { base: string; at: number }>();

async function baseBranch(repo: string): Promise<string> {
  const fromEnv = process.env.STATUS_BASE_BRANCH;
  if (fromEnv) return fromEnv;
  const hit = baseCache.get(repo);
  if (hit && Date.now() - hit.at < 60_000) return hit.base;
  let base = "main";
  const [main, master, head] = await Promise.all([
    git(repo, ["rev-parse", "--verify", "-q", "refs/heads/main"]),
    git(repo, ["rev-parse", "--verify", "-q", "refs/heads/master"]),
    git(repo, ["symbolic-ref", "--short", "HEAD"]),
  ]);
  if (main.ok) base = "main";
  else if (master.ok) base = "master";
  else if (head.ok && head.out) base = head.out;
  baseCache.set(repo, { base, at: Date.now() });
  return base;
}

async function repoContext(repo: string): Promise<RepoCtx> {
  const [base, wt, refs] = await Promise.all([
    baseBranch(repo),
    git(repo, ["worktree", "list", "--porcelain"]),
    git(repo, ["for-each-ref", "--sort=-creatordate", "--format=%(refname:short)", "refs/heads"]),
  ]);
  return {
    repo,
    base,
    worktrees: wt.ok ? parseWorktrees(wt.out) : [],
    branches: refs.ok ? refs.out.split("\n").filter(Boolean) : [],
  };
}

/**
 * Branch for a task when the session cannot tell us: exact "agent/<taskId>", else the newest branch
 * named like Codevisor's worktrees for it ("codevisor/agent-t1-c3cg", "agent-t1", ...).
 */
function guessBranch(taskId: string, ctx: RepoCtx | null): string | null {
  if (!ctx) return null;
  if (ctx.branches.includes(`agent/${taskId}`)) return `agent/${taskId}`;
  const id = taskId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(?:^|/)agent[-/_]${id}(?:-[a-z0-9]+)?$`, "i");
  return ctx.branches.find((b) => re.test(b)) ?? null;
}

/** What the dispatcher recorded per task in runs/<runId>/launches.json (fields we use). */
type LaunchInfo = { branch?: string | null; worktreePath?: string | null; worktreeName?: string | null; launchedAt?: string };

function containingWorktree(path: string, wts: Worktree[]): Worktree | undefined {
  const p = real(path);
  return wts
    .filter((w) => p === real(w.path) || p.startsWith(real(w.path) + "/"))
    .sort((a, b) => b.path.length - a.path.length)[0];
}

/**
 * The worktree a task's session runs in. Order: the live Codevisor session cwd, the worktree path the
 * dispatcher recorded in launches.json, the worktree name, the recorded branch, then a branch named
 * after the task ("agent/<taskId>", "codevisor/agent-<taskId>-xxxx").
 */
function findWorktree(taskId: string, session: CvSession | null, launch: LaunchInfo | null, ctx: RepoCtx | null): Worktree | null {
  const wts = ctx?.worktrees ?? [];
  const paths = [session?.cwd, launch?.worktreePath].filter((p): p is string => !!p && existsSync(p));
  for (const p of paths) {
    const w = containingWorktree(p, wts);
    if (w) return w;
  }
  for (const name of [session?.worktreeName, launch?.worktreeName]) {
    if (!name) continue;
    const byName = wts.find((w) => w.branch === name || basename(w.path) === name || !!w.branch?.endsWith(`/${name}`));
    if (byName) return byName;
  }
  if (paths[0]) return { path: real(paths[0]), branch: null, external: true }; // a checkout outside the repo's list
  const branch = (launch?.branch && ctx?.branches.includes(launch.branch) ? launch.branch : null) ?? guessBranch(taskId, ctx);
  return (branch && wts.find((w) => w.branch === branch)) || null;
}

type Stat = { files: number; ins: number; del: number };

function parseShortstat(out: string): Stat | null {
  if (!out) return null;
  const files = Number(/(\d+) files? changed/.exec(out)?.[1] ?? 0);
  const ins = Number(/(\d+) insertions?\(\+\)/.exec(out)?.[1] ?? 0);
  const del = Number(/(\d+) deletions?\(-\)/.exec(out)?.[1] ?? 0);
  return files || ins || del ? { files, ins, del } : null;
}

function formatStat(s: Stat | null): string | null {
  if (!s) return null;
  return `+${s.ins} -${s.del}, ${s.files} file${s.files === 1 ? "" : "s"}`;
}

type Facts = {
  worktreePath: string | null;
  branch: string | null;
  ahead: number;
  lastCommitAt: number | null;
  diffStat: string | null;
  merged: boolean;
  mergedStat: string | null;
  dirtyFiles: number;
  dirtyStat: string | null;
  dirtyMtime: number | null;
  blocked: { line: string; mtime: number } | null;
};

const NO_BRANCH = { ahead: 0, lastCommitAt: null, diffStat: null, merged: false, mergedStat: null };

async function branchFacts(gitCwd: string, base: string, branch: string | null) {
  if (!branch || branch === base) return NO_BRANCH;
  const tip = await git(gitCwd, ["rev-parse", "--verify", "-q", `refs/heads/${branch}^{commit}`]);
  if (!tip.ok || !tip.out) return NO_BRANCH;
  const range = `${base}..${branch}`;
  const [count, last, stat] = await Promise.all([
    git(gitCwd, ["rev-list", "--count", range]),
    git(gitCwd, ["log", "-1", "--format=%ct", range]),
    git(gitCwd, ["diff", "--shortstat", `${base}...${branch}`]),
  ]);
  const ahead = count.ok ? Number(count.out) || 0 : 0;
  if (ahead > 0) {
    return {
      ahead,
      lastCommitAt: last.out ? Number(last.out) * 1000 : null,
      diffStat: formatStat(parseShortstat(stat.out)),
      merged: false,
      mergedStat: null,
    };
  }
  // Nothing ahead of base: either not started yet, or already merged.
  const [isAncestor, reflog, merges, tipTime] = await Promise.all([
    git(gitCwd, ["merge-base", "--is-ancestor", branch, base]),
    git(gitCwd, ["reflog", "show", "--format=%H", `refs/heads/${branch}`]),
    git(gitCwd, ["log", "--merges", "--format=%P", "-n", "300", base]),
    git(gitCwd, ["log", "-1", "--format=%ct", branch]),
  ]);
  const created = reflog.ok ? (reflog.out.split("\n").filter(Boolean).pop() ?? null) : null;
  const movedSinceCreated = created !== null && created !== tip.out;
  const mergeParent = merges.out.split("\n").some((l) => l.split(" ").slice(1).includes(tip.out));
  const merged = isAncestor.ok && (movedSinceCreated || mergeParent);
  if (!merged) return NO_BRANCH;
  const mergedStat = movedSinceCreated
    ? formatStat(parseShortstat((await git(gitCwd, ["diff", "--shortstat", created!, tip.out])).out))
    : null;
  return { ahead: 0, lastCommitAt: tipTime.out ? Number(tipTime.out) * 1000 : null, diffStat: null, merged: true, mergedStat };
}

const BLOCKED_NAMES = ["BLOCKED.md", "blocked.md", "Blocked.md"];

function cleanLine(line: string): string {
  return line
    .replace(/^\s*(?:#+|[-*>]|\d+[.)])\s*/, "")
    .replace(/[*_`]+/g, "")
    .replace(/^blocked\s*(?:[:\-–—]\s*|$)/i, "")
    .trim();
}

function readBlocked(dir: string): { line: string; mtime: number } | null {
  for (const name of BLOCKED_NAMES) {
    const p = join(dir, name);
    if (!existsSync(p)) continue;
    let line = "";
    try {
      const text = readFileSync(p, "utf8").slice(0, 8192);
      for (const raw of text.split("\n")) {
        line = cleanLine(raw);
        if (line) break;
      }
    } catch {
      /* unreadable: still blocked */
    }
    if (line.length > 160) line = line.slice(0, 157).replace(/\s+\S*$/, "") + "...";
    if (line) line = line[0]!.toUpperCase() + line.slice(1);
    return { line: line || `Blocked, see ${name}`, mtime: mtimeMs(p) ?? Date.now() };
  }
  return null;
}

async function worktreeFacts(path: string | null) {
  const none = { dirtyFiles: 0, dirtyStat: null as string | null, dirtyMtime: null as number | null, blocked: null as Facts["blocked"] };
  if (!path || !existsSync(path)) return none;
  const blocked = readBlocked(path);
  const st = await git(path, ["status", "--porcelain"]);
  const paths: string[] = [];
  let untracked = 0;
  for (const line of st.ok ? st.out.split("\n") : []) {
    if (line.length < 4) continue;
    let p = line.slice(3);
    if (p.includes(" -> ")) p = p.split(" -> ").pop()!;
    p = p.replace(/^"|"$/g, "");
    if (BLOCKED_NAMES.includes(p)) continue;
    paths.push(p);
    if (line.startsWith("??")) untracked++;
  }
  if (!paths.length) return { ...none, blocked };
  let dirtyMtime: number | null = null;
  for (const p of paths.slice(0, 50)) {
    const m = mtimeMs(join(path, p));
    if (m !== null && (dirtyMtime === null || m > dirtyMtime)) dirtyMtime = m;
  }
  const tracked = parseShortstat((await git(path, ["diff", "--shortstat", "HEAD"])).out) ?? { files: 0, ins: 0, del: 0 };
  const dirtyStat = formatStat({ ...tracked, files: tracked.files + untracked });
  return { dirtyFiles: paths.length, dirtyStat, dirtyMtime, blocked };
}

async function collectFacts(
  taskId: string,
  session: CvSession | null,
  launch: LaunchInfo | null,
  ctx: RepoCtx | null,
): Promise<Facts> {
  const wt = findWorktree(taskId, session, launch, ctx);
  let branch = wt?.branch ?? null;
  let gitCwd = ctx?.repo ?? null;
  if (wt?.external) {
    // A checkout outside the demo repo's worktree list: use its own branch if it is a git checkout.
    const head = await git(wt.path, ["symbolic-ref", "--short", "HEAD"]);
    if (head.ok && head.out) {
      gitCwd = wt.path;
      branch = head.out;
    }
  }
  // No worktree (e.g. removed after merging): the branch may still exist.
  if (!branch && !wt) {
    branch = (launch?.branch && ctx?.branches.includes(launch.branch) ? launch.branch : null) ?? guessBranch(taskId, ctx);
  }
  const base = ctx?.base ?? "main";
  const [b, w] = await Promise.all([
    gitCwd ? branchFacts(gitCwd, base, branch) : Promise.resolve(NO_BRANCH),
    worktreeFacts(wt?.path ?? null),
  ]);
  return { worktreePath: wt?.path ?? null, branch, ...b, ...w };
}

// ---------------------------------------------------------------------------------------------
// Status decision
// ---------------------------------------------------------------------------------------------

function ts(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const n = Date.parse(iso);
  return Number.isFinite(n) ? n : null;
}

function botText(s: CvSession | null): string {
  const m = s?.latestBotMessage;
  if (!m) return "";
  if (typeof m === "string") return m;
  if (Array.isArray(m)) return m.map((x) => (typeof x === "string" ? x : (x as { text?: string })?.text ?? "")).join(" ");
  if (typeof m === "object" && typeof (m as { text?: unknown }).text === "string") return (m as { text: string }).text;
  return "";
}

function snippet(text: string, max = 90): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  return t.slice(0, max).replace(/\s+\S*$/, "") + "...";
}

function minutes(ms: number): string {
  const m = Math.max(1, Math.round(ms / 60_000));
  return m >= 120 ? `${Math.round(m / 60)} hours` : `${m} min`;
}

function workingDetail(f: Facts, s: CvSession | null): string {
  if (f.ahead > 0) return `${f.ahead} commit${f.ahead === 1 ? "" : "s"} so far${f.diffStat ? `, ${f.diffStat}` : ""}`;
  if (f.dirtyFiles > 0) return `Editing ${f.dirtyFiles} file${f.dirtyFiles === 1 ? "" : "s"}`;
  const msg = snippet(botText(s));
  return msg || "In progress";
}

function waitingKind(s: CvSession): "question" | "approval" | "planApproval" | null {
  return s.actionRequiredKind ?? (s.pendingPlanApproval ? "planApproval" : null);
}

/** question: pendingQuestion text from GET /v1/agents/{id}, when the session waits on a question. */
function waitingDetail(s: CvSession, question: string | null): string {
  const kind = waitingKind(s);
  if (kind === "approval") return "Waiting for permission approval";
  if (kind === "planApproval") return "Waiting for plan approval";
  if (question) return `Asking: ${snippet(question, 120)}`;
  const msg = snippet(botText(s));
  if (kind === "question") return msg ? `Asking: ${msg}` : "Waiting for your answer";
  return msg ? `Waiting for you: ${msg}` : "Waiting for your input";
}

function errorDetail(s: CvSession, act: SessionActivity | null): string {
  if (s.lastTurnFailure === "usageLimit") return "Hit a usage limit";
  if (act?.errorMessage) return `Error: ${snippet(act.errorMessage, 120)}`;
  if (s.lastTurnFailure === "error") return "Last turn failed";
  return "Session errored in Codevisor";
}

type Decision = { status: AgentStatus; detail: string };

type DecideInput = {
  sessionId: string | null;
  session: CvSession | null;
  act: SessionActivity | null;
  question: string | null;
  facts: Facts;
  base: string;
  apiError: string | null;
  lastActivity: number | null; // from real signals only
  launchedAt: number;
  now: number;
};

function decide(i: DecideInput): Decision {
  const { session: s, facts: f, now } = i;
  const stale = envMs("STATUS_STALE_MS", 600_000);
  const active = envMs("STATUS_ACTIVE_MS", 120_000);
  const quietFor = now - Math.max(i.lastActivity ?? 0, ts(s?.createdAt) ?? i.launchedAt);

  if (!i.sessionId) return { status: "queued", detail: "Not started yet" };
  if (f.merged) return { status: "done", detail: `Merged into ${i.base}${f.mergedStat ? `: ${f.mergedStat}` : ""}` };
  if (s?.isArchived) return { status: "done", detail: `Archived in Codevisor${f.diffStat ? `: ${f.diffStat}` : ""}` };
  if (f.blocked) {
    const resumed = s?.sidebarState === "inProgress" && (ts(s.sidebarStateChangedAt) ?? 0) > f.blocked.mtime;
    if (!resumed) return { status: "stuck", detail: f.blocked.line };
  }

  if (s) {
    const state = s.sidebarState ?? "idle";
    if (state === "waitingForUser" || s.actionRequired || s.pendingPlanApproval) {
      return { status: "stuck", detail: waitingDetail(s, i.question) };
    }
    if (state === "inProgress") {
      if (quietFor > stale) return { status: "stuck", detail: `No activity for ${minutes(quietFor)}` };
      return { status: "working", detail: workingDetail(f, s) };
    }
    if (state === "errored" || s.lastTurnFailure || s.hasUnreadError) {
      return { status: "error", detail: errorDetail(s, i.act) };
    }
    // idle / unread: the agent's turn has ended.
    if (f.ahead > 0) return { status: "needs_review", detail: f.diffStat ?? `${f.ahead} commits` };
    if (f.dirtyFiles > 0) return { status: "needs_review", detail: `${f.dirtyStat ?? `${f.dirtyFiles} files`} (uncommitted)` };
    if (!s.updatedAt && quietFor <= stale) return { status: "working", detail: "Starting up" };
    const msg = snippet(botText(s), 80);
    return { status: "stuck", detail: msg ? `Finished with no changes: ${msg}` : "Finished with no changes" };
  }

  // No Codevisor state: heuristics only.
  const sinceActive = i.lastActivity === null ? Infinity : now - i.lastActivity;
  if (sinceActive <= active) return { status: "working", detail: workingDetail(f, null) };
  if (f.ahead > 0) return { status: "needs_review", detail: f.diffStat ?? `${f.ahead} commits` };
  if (quietFor <= stale) {
    return { status: "working", detail: i.lastActivity === null ? "Starting up" : workingDetail(f, null) };
  }
  const why = i.act?.deleted
    ? "session deleted in Codevisor"
    : i.apiError
      ? i.apiError
      : "session not found in Codevisor";
  return { status: "stuck", detail: `No recent activity (${why})` };
}

// ---------------------------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------------------------

type RunInfo = {
  runId: string;
  tasks: PlanTask[];
  sessions: Record<string, string>;
  launches: Record<string, LaunchInfo>;
  repo: string | null;
  planMtime: number;
  sessionsMtime: number | null;
};

function normalizeLaunches(raw: unknown): Record<string, LaunchInfo> {
  const out: Record<string, LaunchInfo> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [taskId, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!v || typeof v !== "object") continue;
    const l = v as Record<string, unknown>;
    const str = (k: string) => (typeof l[k] === "string" && l[k] ? (l[k] as string) : null);
    out[taskId] = { branch: str("branch"), worktreePath: str("worktreePath"), worktreeName: str("worktreeName"), launchedAt: str("launchedAt") ?? undefined };
  }
  return out;
}

function loadRun(): RunInfo | null {
  const runId = process.env.STATUS_RUN_ID || latestRunId();
  if (!runId) return null;
  const dir = runDir(runId);
  const planPath = join(dir, "plan.json");
  const sessionsPath = join(dir, "sessions.json");
  const sessions = normalizeSessions(readJson<unknown>(sessionsPath));
  const rawLaunches = readJson<Record<string, { title?: unknown; model?: unknown }>>(join(dir, "launches.json"));
  let tasks = normalizeTasks(readJson<Plan>(planPath));
  if (!tasks.length) {
    // No plan.json (e.g. a dispatcher-only run): one task per launched session, titles from launches.json.
    tasks = Object.keys(sessions).map((id) => {
      const l = rawLaunches?.[id];
      const title = typeof l?.title === "string" && l.title.trim() ? l.title.trim() : `Task ${id}`;
      const model = (typeof l?.model === "string" ? l.model : "sonnet") as PlanTask["model"];
      return { id, title, prompt: "", acceptance: [], model, reason: "", dependsOn: [] };
    });
  }
  if (!tasks.length) return null;
  return {
    runId,
    tasks,
    sessions,
    launches: normalizeLaunches(rawLaunches),
    repo: resolveRepo(dir),
    planMtime: mtimeMs(planPath) ?? Date.now(),
    sessionsMtime: mtimeMs(sessionsPath),
  };
}

async function agentFor(
  task: PlanTask,
  run: RunInfo,
  ctx: RepoCtx | null,
  sessions: Map<string, CvSession>,
  apiError: string | null,
  now: number,
): Promise<Agent> {
  const sessionId = run.sessions[task.id] ?? null;
  const base: Omit<Agent, "status" | "detail" | "lastActivityAt"> = {
    taskId: task.id,
    sessionId,
    title: task.title,
    model: String(task.model),
  };
  try {
    if (!sessionId) {
      return { ...base, status: "queued", detail: "Not started yet", lastActivityAt: new Date(run.planMtime).toISOString() };
    }
    const act = getSessionActivity(sessionId);
    const session = sessions.get(sessionId) ?? null;
    const launch = run.launches[task.id] ?? null;
    const waitsOnQuestion =
      !!session &&
      (session.sidebarState === "waitingForUser" || !!session.actionRequired) &&
      (waitingKind(session) === "question" || waitingKind(session) === null);
    const [facts, question] = await Promise.all([
      collectFacts(task.id, session, launch, ctx),
      waitsOnQuestion ? getPendingQuestion(sessionId) : Promise.resolve(null),
    ]);
    const signals = [
      ts(act?.lastEventAt),
      facts.lastCommitAt,
      ts(session?.updatedAt),
      ts(session?.sidebarStateChangedAt),
      facts.dirtyMtime,
      facts.blocked?.mtime ?? null,
    ].filter((n): n is number => typeof n === "number" && Number.isFinite(n));
    const lastActivity = signals.length ? Math.max(...signals) : null;
    const launchedAt = ts(session?.createdAt) ?? ts(launch?.launchedAt) ?? run.sessionsMtime ?? run.planMtime;
    const d = decide({
      sessionId,
      session,
      act,
      question,
      facts,
      base: ctx?.base ?? "main",
      apiError,
      lastActivity,
      launchedAt,
      now,
    });
    let detail = d.detail;
    if (!ctx && (d.status === "working" || d.status === "stuck") && !facts.blocked && !session) {
      detail += " (demo repo not found, set DEMO_REPO)";
    }
    return { ...base, ...d, detail, lastActivityAt: new Date(lastActivity ?? launchedAt).toISOString() };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ...base, status: "error", detail: `Status check failed: ${msg.slice(0, 120)}`, lastActivityAt: new Date(now).toISOString() };
  }
}

/** One Agent per task of the latest run. Never throws; [] when there is no run. */
export async function getAgents(): Promise<Agent[]> {
  let run: RunInfo | null = null;
  try {
    run = loadRun();
    if (!run) return [];
    ensureEventsSubscriber();
    const now = Date.now();
    const anySession = Object.keys(run.sessions).length > 0;
    const [list, ctx] = await Promise.all([
      anySession ? listSessions() : Promise.resolve({ sessions: new Map<string, CvSession>(), error: null }),
      run.repo && anySession ? repoContext(run.repo) : Promise.resolve(null),
    ]);
    const r = run;
    const agents = await Promise.all(r.tasks.map((t) => agentFor(t, r, ctx, list.sessions, list.error, now)));

    // Queued tasks: say what they wait for.
    const byId = new Map(agents.map((a) => [a.taskId, a]));
    const names = shortNames(agents.map((a) => a.title));
    const nameOf = new Map(agents.map((a, i) => [a.taskId, names[i]!]));
    for (const t of r.tasks) {
      const a = byId.get(t.id);
      if (!a || a.status !== "queued") continue;
      const waiting = t.dependsOn.filter((d) => byId.has(d) && byId.get(d)!.status !== "done");
      if (waiting.length) a.detail = `Waiting for ${joinNames(waiting.map((d) => nameOf.get(d) ?? d))}`;
    }
    return agents;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[status] getAgents failed: ${msg}`);
    if (!run) return [];
    const now = new Date().toISOString();
    return run.tasks.map((t) => ({
      taskId: t.id,
      sessionId: run!.sessions[t.id] ?? null,
      title: t.title,
      model: String(t.model),
      status: run!.sessions[t.id] ? ("error" as const) : ("queued" as const),
      detail: `Status check failed: ${msg.slice(0, 120)}`,
      lastActivityAt: now,
    }));
  }
}

export async function getStandup(): Promise<StandupResponse> {
  const agents = await getAgents();
  return { summary: summarize(agents), agents };
}

// ---------------------------------------------------------------------------------------------
// Speakable summary
// ---------------------------------------------------------------------------------------------

const LEAD_VERBS = new Set(
  (
    "add adds implement write create build fix update refactor set setup make wire integrate support improve " +
    "polish enable introduce migrate document handle ship finish clean cleanup replace remove rename extract " +
    "move convert port hook connect configure scaffold bootstrap generate draft design style switch send " +
    "rework rewrite restyle redesign harden optimize speed tidy upgrade bump"
  ).split(" "),
);
const FILLER = new Set(["a", "an", "the", "up", "new", "basic", "simple", "initial", "proper", "some"]);
const TAIL_NOUNS = new Set(
  "page component components feature flow logic module endpoint endpoints button toggle section screen view ui support functionality file files".split(
    " ",
  ),
);
const CUT = /\s+(?:for|to|with|in|on|using|via|from|into|so|that|when|across|by|of)\s+|\s*[:;,(\[]\s*|\s+[-–—]\s+/i;

function tidyWords(text: string): string[] {
  return text
    .replace(/\([^)]*\)|\[[^\]]*\]/g, " ") // (CHK-12), [t1]
    .replace(/\b[A-Z]{2,}-\d+\b/g, " ") // ticket keys
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.replace(/\.(md|ts|tsx|js|jsx|json|css|html)$/i, ""))
    .map((w) => (w.length >= 5 && w === w.toUpperCase() && /[A-Z]/.test(w) ? w[0] + w.slice(1).toLowerCase() : w));
}

function capitalize(s: string): string {
  return s ? s[0]!.toUpperCase() + s.slice(1) : s;
}

/** A short speakable name for a task title: "Write tests for the checkout flow" -> "Tests". */
export function shortName(title: string): string {
  let words = tidyWords(title);
  while (words.length > 1 && (LEAD_VERBS.has(words[0]!.toLowerCase()) || FILLER.has(words[0]!.toLowerCase()))) words.shift();
  const head = words.join(" ").split(CUT)[0]!.trim();
  words = head ? head.split(/\s+/) : words;
  words = words.filter((w, i) => i === 0 || !FILLER.has(w.toLowerCase()));
  while (words.length > 1 && TAIL_NOUNS.has(words[words.length - 1]!.toLowerCase())) words.pop();
  const name = words.slice(0, 3).join(" ").replace(/[.,:;!?]+$/, "");
  return capitalize(name || title.trim());
}

/** Short names for a list of titles; colliding names fall back to the fuller title. */
export function shortNames(titles: string[]): string[] {
  const names = titles.map(shortName);
  const count = new Map<string, number>();
  for (const n of names) count.set(n.toLowerCase(), (count.get(n.toLowerCase()) ?? 0) + 1);
  return names.map((n, i) => {
    if ((count.get(n.toLowerCase()) ?? 0) < 2) return n;
    const full = tidyWords(titles[i]!).slice(0, 6).join(" ");
    return capitalize(full || n);
  });
}

const NUMBER_WORDS = "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty".split(" ");

function numberWord(n: number): string {
  return NUMBER_WORDS[n] ?? String(n);
}

function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** Ends a sentence with a period unless it already ends with . ? or ! */
function sentence(s: string): string {
  const t = s.trim().replace(/(\.\.\.|…)$/, "");
  return /[.?!]$/.test(t) ? t : `${t}.`;
}

function lowerFirst(d: string): string {
  // Keep acronyms and identifiers ("API", "STRIPE_KEY") as they are.
  return d && !/^[A-Z][A-Z0-9_]/.test(d) ? d[0]!.toLowerCase() + d.slice(1) : d;
}

/** Turns a card detail into the tail of a spoken sentence: "Needs a key" -> "it needs a key". */
function speakableDetail(detail: string): string {
  let d = detail
    .replace(/[`*_#]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\s*\([^)]*\)\s*([.!]*)$/, "$1") // a trailing "(STRIPE_TEST_KEY)" reads badly aloud
    .replace(/[.!\s]+$/, "");
  if (d.length > 140) d = d.slice(0, 140).replace(/\s+\S*$/, "");
  if (!d) return "it needs your input";
  if (/^needs?\b/i.test(d)) return `it needs${d.replace(/^needs?/i, "")}`;
  if (/^missing\b/i.test(d)) return `it's missing${d.replace(/^missing/i, "")}`;
  return lowerFirst(d);
}

/** One spoken sentence for a stuck agent, shaped by the kind of detail. */
function stuckSentence(name: string, detail: string): string {
  let m: RegExpMatchArray | null;
  if ((m = /^Asking: (.+)$/.exec(detail))) return sentence(`${name} is stuck on a question: ${m[1]}`);
  if ((m = /^Waiting for (permission|plan) approval/.exec(detail))) return `${name} is waiting for your ${m[1]} approval.`;
  if ((m = /^Waiting for (?:you|your input)(?:: (.+))?$/.exec(detail))) {
    return sentence(`${name} is waiting for you${m[1] ? `: ${m[1]}` : ""}`);
  }
  if ((m = /^Finished with no changes(?:: (.+))?$/.exec(detail))) {
    return m[1] ? `${name} stopped without changes. Its last message: ${sentence(m[1])}` : `${name} stopped without changes.`;
  }
  return sentence(`${name} is stuck: ${speakableDetail(detail)}`);
}

/** Speakable standup text. Order: stuck, needs review, errors, working, done, queued. */
export function summarize(agents: Agent[]): string {
  if (!agents.length) return "No agents running yet.";
  const names = shortNames(agents.map((a) => a.title));
  const named = agents.map((a, i) => ({ a, name: names[i]! }));
  const of = (s: AgentStatus) => named.filter((x) => x.a.status === s);
  const verb = (n: number) => (n === 1 ? "is" : "are");
  const parts: string[] = [`${capitalize(numberWord(agents.length))} agent${agents.length === 1 ? "" : "s"}.`];

  for (const { a, name } of of("stuck")) parts.push(stuckSentence(name, a.detail));
  const review = of("needs_review");
  if (review.length) parts.push(`${joinNames(review.map((x) => x.name))} ${verb(review.length)} ready for your review.`);
  for (const { a, name } of of("error")) {
    parts.push(/usage limit/i.test(a.detail) ? `${name} hit a usage limit.` : `${name} hit an error.`);
  }
  const working = of("working");
  if (working.length) parts.push(`${joinNames(working.map((x) => x.name))} ${verb(working.length)} still working.`);
  const done = of("done");
  if (done.length) parts.push(`${joinNames(done.map((x) => x.name))} ${verb(done.length)} done.`);
  const queued = of("queued");
  if (queued.length) {
    parts.push(
      queued.length === 1
        ? `${queued[0]!.name} is queued.`
        : `${capitalize(numberWord(queued.length))} tasks are queued.`,
    );
  }
  return parts.join(" ");
}
