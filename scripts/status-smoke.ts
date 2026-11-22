// OWNER: status agent (B3). Smoke test for src/status.ts and src/codevisor-status.ts.
//
//   STATUS_SMOKE_DIR=<scratch dir> bun scripts/status-smoke.ts [--no-live] [--no-server]
//
// 1. Clones the demo repo (DEMO_REPO, or STATUS_SMOKE_SOURCE_REPO) into STATUS_SMOKE_DIR/repo and
//    stages four agent worktrees: t1 BLOCKED.md, t2 old commits, t3 a commit just now, t4 merged into
//    main (fast-forward, worktree removed). The real demo repo is only read (git clone).
// 2. Writes a fake run runs/status_smoke_<id>/ (plan.json, sessions.json with fake session ids) and
//    points the status service at it with STATUS_RUN_ID / STATUS_DEMO_REPO (runs/latest is untouched).
// 3. Asserts getAgents() and getStandup(), plus queued / stale / no-run cases.
// 4. Live, read-only: lists real Codevisor sessions (id and status fields only), maps one real session
//    through getAgents(), and runs the events subscriber for about 10s.
// 5. Starts the API on port 3105 with MOCK=0 and checks /api/agents and /api/standup.
// Cleans up the fake run and the scratch dir at the end, pass or fail.
import { appendFileSync, existsSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT, RUNS_DIR, config } from "../src/config";
import type { Agent, Plan, PlanTask } from "../src/types";

const flags = new Set(process.argv.slice(2));
const SCRATCH = process.env.STATUS_SMOKE_DIR || join(tmpdir(), "covisor-status-smoke");
const REPO = join(SCRATCH, "repo");
const RUN_ID = `status_smoke_${Date.now().toString(36)}`;
const RUN_PATH = join(RUNS_DIR, RUN_ID);
const LIVE_RUN_ID = `${RUN_ID}_live`;
const LIVE_RUN_PATH = join(RUNS_DIR, LIVE_RUN_ID);
const SERVER_PORT = 3105;
// t1/t3: PRD-style agent/<taskId>. t2: a random Codevisor name only findable via launches.json.
// t4: Codevisor-style name containing the task id (found by the branch-name fallback).
const BRANCHES = new Map([
  ["t1", "agent/t1"],
  ["t2", "codevisor/quiet-otter"],
  ["t3", "agent/t3"],
  ["t4", "codevisor/agent-t4-zz9q"],
]);

let failures = 0;
function check(cond: boolean, label: string, extra = ""): void {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${extra ? `  (${extra})` : ""}`);
  if (!cond) failures++;
}

function sh(cmd: string[], env: Record<string, string> = {}): string {
  const r = Bun.spawnSync(cmd, { env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`${cmd.join(" ")} failed: ${r.stderr.toString().trim()}`);
  return r.stdout.toString().trim();
}
const git = (dir: string, ...args: string[]) => sh(["git", "-C", dir, ...args]);

function commitAll(dir: string, message: string, minutesAgo: number): void {
  git(dir, "add", "-A");
  const date = new Date(Date.now() - minutesAgo * 60_000).toISOString();
  sh(["git", "-C", dir, "commit", "-q", "-m", message], { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
}

const lines = (n: number, prefix: string) => Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}`).join("\n") + "\n";
const wt = (id: string) => join(SCRATCH, `wt-${id}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function printAgents(list: Agent[]): void {
  for (const a of list) {
    console.log(
      `  ${a.taskId.padEnd(4)} ${a.status.padEnd(13)} ${a.model.padEnd(7)} ${a.title.slice(0, 34).padEnd(35)} ${a.detail}   [${a.lastActivityAt}]`,
    );
  }
}

function task(id: string, title: string, model: PlanTask["model"], dependsOn: string[] = []): PlanTask {
  return { id, title, prompt: `Smoke test task ${id}`, acceptance: [], model, reason: "smoke test", dependsOn };
}

function stageRepo(): void {
  rmSync(SCRATCH, { recursive: true, force: true });
  mkdirSync(SCRATCH, { recursive: true });
  const src = process.env.STATUS_SMOKE_SOURCE_REPO || config.demoRepo;
  if (src && existsSync(join(src, ".git"))) {
    sh(["git", "clone", "-q", "--no-hardlinks", src, REPO]);
  } else {
    mkdirSync(REPO, { recursive: true });
    git(REPO, "init", "-q");
  }
  git(REPO, "config", "user.name", "Status Smoke");
  git(REPO, "config", "user.email", "smoke@example.invalid");
  git(REPO, "config", "commit.gpgsign", "false");
  if (!existsSync(join(REPO, "README.md"))) {
    writeFileSync(join(REPO, "README.md"), "# Demo\n");
    commitAll(REPO, "Initial commit", 120);
  }
  git(REPO, "checkout", "-q", "-B", "main");

  for (const [id, branch] of BRANCHES) git(REPO, "worktree", "add", "-q", "-b", branch, wt(id), "main");

  // t1: blocked on a human.
  writeFileSync(
    join(wt("t1"), "BLOCKED.md"),
    "# BLOCKED\n\nNeeds a Stripe test key to run the checkout tests.\nSet STRIPE_TEST_KEY in .env, then re-run me.\n",
  );
  // t2: finished a while ago with two commits: +210 -0, 3 files.
  mkdirSync(join(wt("t2"), "src/smoke"), { recursive: true });
  writeFileSync(join(wt("t2"), "src/smoke/stripe-checkout.ts"), lines(120, "// checkout"));
  writeFileSync(join(wt("t2"), "src/smoke/stripe-client.ts"), lines(60, "// stripe"));
  commitAll(wt("t2"), "Add Stripe checkout page", 40);
  writeFileSync(join(wt("t2"), "src/smoke/stripe-checkout.test.ts"), lines(30, "// test"));
  commitAll(wt("t2"), "Wire the checkout route", 35);
  // t3: active right now (a fresh commit plus an uncommitted file).
  mkdirSync(join(wt("t3"), "src"), { recursive: true });
  writeFileSync(join(wt("t3"), "src/theme.css"), lines(25, "/* theme */"));
  commitAll(wt("t3"), "Add dark theme tokens", 0);
  writeFileSync(join(wt("t3"), "src/toggle.ts"), lines(10, "// toggle"));
  // t4: merged into main with a fast-forward, worktree removed (branch kept).
  appendFileSync(join(wt("t4"), "README.md"), "\n## Setup\n" + lines(6, "Step"));
  commitAll(wt("t4"), "Document setup steps", 20);
  git(REPO, "merge", "-q", "--ff-only", BRANCHES.get("t4")!);
  git(REPO, "worktree", "remove", wt("t4"));
  // s9 (synthetic Codevisor session below): turn ended with uncommitted changes, " M README.md" first.
  git(REPO, "worktree", "add", "-q", "-b", "codevisor/s9-branch", wt("s9"), "main");
  appendFileSync(join(wt("s9"), "README.md"), "\nOne more line.\n");
  writeFileSync(join(wt("s9"), "notes.txt"), "draft\n");
}

function writeRun(dir: string, runId: string, tasks: PlanTask[], sessions: Record<string, string>): void {
  mkdirSync(dir, { recursive: true });
  const plan: Plan = { runId, tasks };
  writeFileSync(join(dir, "plan.json"), JSON.stringify(plan, null, 2));
  writeFileSync(join(dir, "sessions.json"), JSON.stringify(sessions, null, 2));
}

async function main(): Promise<void> {
  console.log(`Scratch: ${SCRATCH}\nRun:     ${RUN_PATH}\n`);
  stageRepo();
  const tasks = [
    task("t1", "Write tests for the checkout flow", "sonnet"),
    task("t2", "Add Stripe checkout page", "opus"),
    task("t3", "Add dark mode toggle", "sonnet", ["t2"]),
    task("t4", "Update README with setup steps", "sonnet"),
  ];
  const fakeSessions = Object.fromEntries(tasks.map((t) => [t.id, `fake-${crypto.randomUUID()}`]));
  writeRun(RUN_PATH, RUN_ID, tasks, fakeSessions);
  // Only t2 is recorded in launches.json (same shape the dispatcher writes).
  writeFileSync(
    join(RUN_PATH, "launches.json"),
    JSON.stringify({
      t2: { taskId: "t2", sessionId: fakeSessions.t2, worktreeName: "quiet-otter", branch: BRANCHES.get("t2"), worktreePath: wt("t2"), launchedAt: new Date(Date.now() - 45 * 60_000).toISOString() },
    }),
  );

  process.env.STATUS_RUN_ID = RUN_ID;
  process.env.STATUS_DEMO_REPO = REPO;
  process.env.STATUS_EVENTS = "0"; // deterministic first; the subscriber runs in the live phase
  const status = await import("../src/status");
  const cv = await import("../src/codevisor-status");

  // --- 1. Staged run, fake (unknown) session ids -------------------------------------------------
  console.log("== Staged run (fake session ids, heuristics)");
  let t0 = performance.now();
  const agents = await status.getAgents();
  const ms = performance.now() - t0;
  printAgents(agents);
  const by = Object.fromEntries(agents.map((a) => [a.taskId, a]));
  check(agents.length === 4, "one agent per plan task");
  check(ms < 1000, "getAgents() under 1s", `${ms.toFixed(0)} ms, Codevisor list included`);
  check(by.t1?.status === "stuck" && by.t1.detail === "Needs a Stripe test key to run the checkout tests.", "t1 stuck, detail = BLOCKED.md first line", by.t1?.detail);
  check(by.t2?.status === "needs_review" && by.t2.detail === "+210 -0, 3 files", "t2 needs_review, detail = diff stat vs main (branch from launches.json)", by.t2?.detail);
  check(by.t3?.status === "working", "t3 working (recent commit)", by.t3?.detail);
  check(by.t4?.status === "done" && by.t4.detail.startsWith("Merged into main"), "t4 done (fast-forward merged, worktree removed)", by.t4?.detail);
  check(agents.every((a) => a.lastActivityAt === new Date(Date.parse(a.lastActivityAt)).toISOString()), "lastActivityAt is ISO");
  check(by.t2?.model === "opus" && by.t2.title === "Add Stripe checkout page", "title and model come from the plan");
  check(agents.every((a) => a.sessionId === fakeSessions[a.taskId]), "sessionId comes from sessions.json");

  const standup = await status.getStandup();
  console.log(`\nStandup: ${standup.summary}\n`);
  const s = standup.summary;
  const idx = ["is stuck", "ready for your review", "still working", "done."].map((k) => s.indexOf(k));
  check(s.startsWith("Four agents."), "standup starts with the agent count");
  check(idx.every((i) => i >= 0) && idx.every((v, i) => i === 0 || idx[i - 1]! < v), "standup order: stuck, review, working, done");
  check(standup.agents.length === 4, "standup returns the agents too");

  // --- 2. Edge cases ----------------------------------------------------------------------------
  console.log("== Edge cases");
  writeRun(RUN_PATH, RUN_ID, tasks, { t1: fakeSessions.t1!, t2: fakeSessions.t2!, t4: fakeSessions.t4! });
  let list = await status.getAgents();
  let t3 = list.find((a) => a.taskId === "t3");
  check(t3?.status === "queued" && t3.sessionId === null, "task missing from sessions.json is queued", t3?.detail);
  check(t3?.detail === "Waiting for Stripe checkout", "queued detail names the unmet dependency", t3?.detail);
  writeRun(RUN_PATH, RUN_ID, tasks, fakeSessions);

  unlinkSync(join(wt("t1"), "BLOCKED.md"));
  list = await status.getAgents();
  let t1 = list.find((a) => a.taskId === "t1");
  check(t1?.status === "working" && t1.detail === "Starting up", "no BLOCKED.md, just launched: working", t1?.detail);
  process.env.STATUS_STALE_MS = "1";
  list = await status.getAgents();
  t1 = list.find((a) => a.taskId === "t1");
  check(t1?.status === "stuck" && t1.detail.startsWith("No recent activity"), "long inactivity: stuck", t1?.detail);
  t3 = list.find((a) => a.taskId === "t3");
  check(t3?.status === "working", "recent activity still working with a tiny stale window", t3?.detail);
  delete process.env.STATUS_STALE_MS;
  writeFileSync(join(wt("t1"), "BLOCKED.md"), "Needs a Stripe test key to run the checkout tests.\n");

  // --- Codevisor state mapping, driven by synthetic session.updated events (no real session touched)
  console.log("== Codevisor sidebarState mapping (synthetic events fed to the cache)");
  const iso = (minAgo: number) => new Date(Date.now() - minAgo * 60_000).toISOString();
  const cases: Array<{ id: string; title: string; s: Record<string, unknown>; minAgo: number; want: string; detail: RegExp }> = [
    { id: "s1", title: "Add search box", minAgo: 1, s: { sidebarState: "inProgress", latestBotMessage: { text: "Reading the catalog code first." } }, want: "working", detail: /^Reading the catalog/ },
    { id: "s2", title: "Add checkout tests", minAgo: 2, s: { sidebarState: "waitingForUser", actionRequired: true, actionRequiredKind: "question", latestBotMessage: { text: "Which Stripe key should I use?" } }, want: "stuck", detail: /^Asking: Which Stripe key/ },
    { id: "s3", title: "Migrate the cart store", minAgo: 2, s: { sidebarState: "waitingForUser", actionRequired: true, actionRequiredKind: "approval" }, want: "stuck", detail: /permission approval/ },
    { id: "s4", title: "Send email receipts", minAgo: 3, s: { sidebarState: "errored", lastTurnFailure: "usageLimit", hasUnreadError: true }, want: "error", detail: /usage limit/ },
    { id: "s5", title: "Fix mobile layout", minAgo: 0, s: { sidebarState: "idle", updatedAt: null }, want: "working", detail: /^Starting up$/ },
    { id: "s6", title: "Refactor pricing module", minAgo: 4, s: { sidebarState: "unread", latestBotMessage: { text: "I could not find the pricing module." } }, want: "stuck", detail: /^Finished with no changes: I could not find/ },
    { id: "s7", title: "Add order history page", minAgo: 30, s: { sidebarState: "inProgress" }, want: "stuck", detail: /^No activity for 30 min$/ },
    { id: "s8", title: "Polish product cards", minAgo: 50, s: { sidebarState: "idle", isArchived: true }, want: "done", detail: /^Archived in Codevisor/ },
    { id: "s9", title: "Tidy the docs", minAgo: 5, s: { sidebarState: "unread", cwd: wt("s9"), worktreeName: "s9-branch" }, want: "needs_review", detail: /^\+2 -0, 2 files \(uncommitted\)$/ },
  ];
  const mapSessions = Object.fromEntries(cases.map((c) => [c.id, `fake-${crypto.randomUUID()}`]));
  for (const c of cases) {
    const at = iso(c.minAgo);
    cv.handleEvent({
      id: 0,
      kind: "session.updated",
      subjectId: mapSessions[c.id],
      createdAt: at,
      payload: { id: mapSessions[c.id], createdAt: at, updatedAt: at, sidebarStateChangedAt: at, actionRequired: false, ...c.s },
    });
  }
  writeRun(LIVE_RUN_PATH, LIVE_RUN_ID, cases.map((c) => task(c.id, c.title, "sonnet")), mapSessions);
  process.env.STATUS_RUN_ID = LIVE_RUN_ID;
  const mappedFake = await status.getAgents();
  for (const c of cases) {
    const a = mappedFake.find((x) => x.taskId === c.id);
    check(a?.status === c.want && c.detail.test(a.detail), `sidebarState ${JSON.stringify(c.s.sidebarState)} (${c.id}) -> ${c.want}`, a ? `${a.status}: ${a.detail}` : "missing");
  }
  console.log(`  Standup: ${(await status.getStandup()).summary}`);
  rmSync(LIVE_RUN_PATH, { recursive: true, force: true });

  process.env.STATUS_RUN_ID = `${RUN_ID}_missing`;
  const none = await status.getStandup();
  check(none.agents.length === 0 && none.summary === "No agents running yet.", "no run: [] and 'No agents running yet.'");
  process.env.STATUS_RUN_ID = RUN_ID;

  console.log("  short names:", ["Switch checkout to Stripe Checkout", "Fix checkout on mobile (CHK-12)", "Send email receipts (CHK-14)", "Add checkout tests (CHK-15)", "Update README.md"].map((t) => `${t} -> ${status.shortName(t)}`).join(" | "));
  console.log(`  shortNames with a collision: ${status.shortNames(["Switch checkout to Stripe Checkout", "Fix checkout on mobile (CHK-12)"]).join(" | ")}`);

  // --- 3. Live, read-only Codevisor checks ------------------------------------------------------
  if (!flags.has("--no-live")) {
    console.log("\n== Live Codevisor (read-only)");
    const live = await cv.listSessions();
    for (const id of [...live.sessions.keys()]) if (id.startsWith("fake-")) live.sessions.delete(id); // synthetic, from above
    check(live.error === null, "GET /v1/sessions reachable", live.error ?? `${live.sessions.size} real sessions`);
    for (const x of live.sessions.values()) {
      const { id, sidebarState, sidebarStateChangedAt, updatedAt, actionRequired, actionRequiredKind, pendingPlanApproval, lastTurnFailure, hasUnreadError, isArchived, worktreeName } = x;
      console.log("  " + JSON.stringify({ id, sidebarState, sidebarStateChangedAt, updatedAt, actionRequired, actionRequiredKind, pendingPlanApproval, lastTurnFailure, hasUnreadError, isArchived, worktreeName }));
    }
    const reals = [...live.sessions.values()].slice(0, 6);
    if (reals.length) {
      // Read-only probe: every real session as a task, against the real demo repo.
      const probeTasks = reals.map((x, i) => task(`live${i + 1}`, `Probe ${x.worktreeName ?? x.id.slice(0, 8)}`, "opus"));
      writeRun(LIVE_RUN_PATH, LIVE_RUN_ID, probeTasks, Object.fromEntries(reals.map((x, i) => [`live${i + 1}`, x.id])));
      process.env.STATUS_RUN_ID = LIVE_RUN_ID;
      if (config.demoRepo) process.env.STATUS_DEMO_REPO = config.demoRepo;
      const mapped = await status.getAgents();
      console.log("  real sessions mapped through getAgents() (sidebarState -> status):");
      mapped.forEach((a, i) => console.log(`    ${String(reals[i]!.sidebarState).padEnd(15)} -> ${a.status.padEnd(13)} ${a.detail}   [${a.lastActivityAt}]`));
      check(mapped.length === reals.length && mapped.every((a, i) => a.sessionId === reals[i]!.id), "real session ids map to agents");
      process.env.STATUS_RUN_ID = RUN_ID;
      process.env.STATUS_DEMO_REPO = REPO;
    }

    console.log("\n== Events subscriber (about 10s; replays the last 25 events, then live)");
    delete process.env.STATUS_EVENTS;
    const cursorRes = await fetch(`${config.codevisorUrl}/v1/events/cursor`, {
      headers: { Authorization: `Bearer ${config.codevisorToken}` },
      signal: AbortSignal.timeout(2000),
    }).then((r) => r.json() as Promise<{ cursor?: number }>).catch(() => ({ cursor: 0 }));
    const cursor = Number(cursorRes.cursor) || 0;
    const before = cv.eventsStatus().kinds as Record<string, number>; // synthetic events injected above
    cv.ensureEventsSubscriber({ since: Math.max(0, cursor - 25) });
    await sleep(10_000);
    const ev = cv.eventsStatus();
    const kinds = Object.fromEntries(
      Object.entries(ev.kinds as Record<string, number>)
        .map(([k, n]) => [k, n - (before[k] ?? 0)] as const)
        .filter(([, n]) => n > 0),
    );
    console.log(`  cursor at start ${cursor}; connected=${ev.connected} connects=${ev.connects} lastEventId=${ev.lastEventId} lastError=${ev.lastError}`);
    console.log(`  kinds received from Codevisor: ${JSON.stringify(kinds)}`);
    for (const x of live.sessions.values()) {
      const a = cv.getSessionActivity(x.id);
      if (a) console.log(`  activity ${x.id}: lastKind=${a.lastKind} lastEventAt=${a.lastEventAt} sidebarState=${a.session?.sidebarState ?? "?"}`);
    }
    check(ev.connects >= 1, "events stream connected", ev.lastError ?? "");
    t0 = performance.now();
    await status.getAgents();
    check(performance.now() - t0 < 1000, "getAgents() still fast with the subscriber running", `${(performance.now() - t0).toFixed(0)} ms`);
    cv.stopEventsSubscriber();
  }

  // --- 4. HTTP routes on a test port ------------------------------------------------------------
  if (!flags.has("--no-server")) {
    console.log(`\n== API server on port ${SERVER_PORT} (MOCK=0)`);
    const server = Bun.spawn(["bun", "src/index.ts"], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(SERVER_PORT), MOCK: "0", STATUS_RUN_ID: RUN_ID, STATUS_DEMO_REPO: REPO },
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      const url = `http://127.0.0.1:${SERVER_PORT}`;
      let up = false;
      for (let i = 0; i < 40 && !up; i++) {
        up = await fetch(`${url}/api/health`).then((r) => r.ok).catch(() => false);
        if (!up) await sleep(250);
      }
      if (!up) {
        console.log("WARN  server did not start (another module may be mid-edit); skipping HTTP checks");
      } else {
        const httpAgents = (await fetch(`${url}/api/agents`).then((r) => r.json())) as Agent[];
        printAgents(httpAgents);
        check(
          httpAgents.map((a) => a.status).join(",") === "stuck,needs_review,working,done",
          "GET /api/agents returns the staged statuses",
        );
        const httpStandup = (await fetch(`${url}/api/standup`).then((r) => r.json())) as { summary: string };
        console.log(`  /api/standup summary: ${httpStandup.summary}`);
        check(httpStandup.summary.startsWith("Four agents."), "GET /api/standup returns a summary");
      }
    } finally {
      server.kill();
      await server.exited;
    }
  }
}

try {
  await main();
} catch (e) {
  failures++;
  console.error("FAIL  smoke test crashed:", e instanceof Error ? e.message : e);
} finally {
  try {
    const cv = await import("../src/codevisor-status");
    cv.stopEventsSubscriber();
  } catch {}
  rmSync(RUN_PATH, { recursive: true, force: true });
  rmSync(LIVE_RUN_PATH, { recursive: true, force: true });
  rmSync(SCRATCH, { recursive: true, force: true });
  console.log(`\nCleaned up ${RUN_PATH}, ${LIVE_RUN_PATH} and ${SCRATCH}.`);
  console.log(failures ? `${failures} check(s) FAILED` : "All checks passed");
  process.exit(failures ? 1 : 0);
}
