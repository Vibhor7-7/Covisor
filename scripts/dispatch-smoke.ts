// M5 smoke test: dispatch a 1-task plan into a real Codevisor session, then verify it via the API.
//   bun scripts/dispatch-smoke.ts                 creates ONE real session (don't loop this)
//   bun scripts/dispatch-smoke.ts --verify <id>   only re-checks an existing session, creates nothing
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { findProjectByPath, getSession, type Session } from "../src/codevisor";
import { config } from "../src/config";
import { dispatchPlan } from "../src/dispatch";
import { createRun, emit, newRunId, runDir, streamRun } from "../src/runs";
import type { Plan } from "../src/types";

const PROMPT =
  "Add a line 'Built with Codevisor' to README.md and commit it. " +
  "If you need anything from a human, write BLOCKED.md and stop.";

async function rawGet<T>(path: string): Promise<T> {
  const res = await fetch(`${config.codevisorUrl}${path}`, {
    headers: { authorization: `Bearer ${config.codevisorToken}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`GET ${path} -> HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

type Detail = { session: Session; conversation?: Array<{ role: string; text?: string }> };
const sessionDetail = (id: string) => rawGet<Detail>(`/v1/sessions/${encodeURIComponent(id)}`);

type Snapshot = {
  workspaces: Array<{ id: string; name: string; projectId: string; mainSessionId?: string | null }>;
  panes: Array<{ workspaceId: string; paneType: string; resourceKind?: string | null; resourceId?: string | null }>;
};

async function verify(sessionId: string, expectPrompt: string | null, waitMs: number) {
  const project = await findProjectByPath(config.demoRepo);
  const s = await getSession(sessionId);
  console.log("\n== Session (GET /v1/sessions/{id} .session)");
  console.log(
    JSON.stringify(
      {
        id: s.id,
        title: s.title,
        projectId: s.projectId,
        inDemoProject: s.projectId === project?.id,
        harnessId: s.harnessId,
        worktreeName: s.worktreeName ?? null,
        cwd: s.cwd ?? null,
        workspaceId: s.workspaceId ?? null,
        configSelections: s.configSelections ?? null,
        unavailableConfigSelections: s.unavailableConfigSelections ?? null,
        labels: s.labels ?? null,
        sidebarState: s.sidebarState ?? null,
        actionRequired: s.actionRequired ?? null,
        hasUnreadError: s.hasUnreadError ?? null,
      },
      null,
      2,
    ),
  );

  // What the Codevisor app renders: workspaces (sidebar items) holding chat panes.
  const snap = await rawGet<Snapshot>("/v1/workspace-snapshot");
  const pane = snap.panes.find((p) => p.resourceKind === "session" && p.resourceId === sessionId);
  const ws = snap.workspaces.find((w) => w.id === (pane?.workspaceId ?? s.workspaceId));
  console.log(
    `\n== In the app: workspace=${ws ? `${ws.name} (${ws.id})` : "none"}, chat pane=${pane ? "yes" : "no"}`,
  );

  const detail = await sessionDetail(sessionId);
  const userMsgs = (detail.conversation ?? []).filter((m) => m.role === "user");
  const first = userMsgs[0]?.text ?? "";
  console.log(`\n== First user message (${userMsgs.length} user message(s)):\n${first.slice(0, 300)}`);
  if (expectPrompt) console.log(`prompt delivered: ${first.includes(expectPrompt.slice(0, 40))}`);

  // Watch the state change for a bit (no new sessions, read-only polling).
  const seen: string[] = [];
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    const cur = await getSession(sessionId);
    const state = `${cur.sidebarState ?? "null"}${cur.actionRequired ? `/action:${cur.actionRequiredKind}` : ""}`;
    if (seen[seen.length - 1] !== state) {
      seen.push(state);
      console.log(`${new Date().toISOString()} sidebarState=${state}`);
    }
    if (cur.sidebarState === "idle" && seen.length > 1) break;
    await Bun.sleep(3000);
  }
  console.log(`states seen: ${seen.join(" -> ")}`);
}

async function main() {
  const args = process.argv.slice(2);
  const vi = args.indexOf("--verify");
  if (vi >= 0) {
    const id = args[vi + 1];
    if (!id) throw new Error("usage: --verify <sessionId>");
    await verify(id, null, 15_000);
    return;
  }

  const runId = newRunId();
  createRun(runId);
  console.log(`runId: ${runId}\nrunDir: ${runDir(runId)}\n== Events`);

  const printer = (async () => {
    for await (const e of streamRun(runId)) console.log(JSON.stringify(e));
  })();

  const plan: Plan = {
    runId,
    tasks: [
      {
        id: "t1",
        title: "Add Built with Codevisor line",
        prompt: PROMPT,
        acceptance: ["README.md contains the line 'Built with Codevisor'", "The change is committed on this branch"],
        model: "sonnet",
        reason: "Routine one-line docs change",
        dependsOn: [],
      },
    ],
  };
  await dispatchPlan(runId, plan);
  emit(runId, { type: "done" }); // ends the stream printer (dispatch itself never emits done)
  await printer;

  const sessions = JSON.parse(readFileSync(join(runDir(runId), "sessions.json"), "utf8")) as Record<string, string>;
  console.log(`\nsessions.json: ${JSON.stringify(sessions)}`);
  console.log(`launches.json: ${readFileSync(join(runDir(runId), "launches.json"), "utf8")}`);
  const sid = sessions.t1;
  if (!sid) throw new Error("no session recorded for t1");
  await verify(sid, PROMPT, 90_000);
}

main().catch((err) => {
  console.error(`smoke failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
