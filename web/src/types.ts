// The shared contract from PRD section 4. Keep in sync with the backend.

export type Spec = {
  title: string;
  goal: string;
  user: string;
  scopeIn: string[];
  scopeOut: string[];
  decisions: string[];
  constraints: string[];
  acceptance: string[];
  openQuestions: string[];
  repoPath: string;
};

export type Plan = {
  runId: string;
  tasks: Array<{
    id: string;
    title: string;
    prompt: string;
    acceptance: string[];
    model: "opus" | "sonnet" | "local";
    reason: string;
    dependsOn: string[];
  }>;
};

export type AgentStatus = "queued" | "working" | "needs_review" | "stuck" | "done" | "error";

export type Agent = {
  taskId: string;
  sessionId: string | null;
  title: string;
  model: string;
  status: AgentStatus;
  detail: string;
  lastActivityAt: string;
};

export type Issue = { id: string; key: string; title: string; state: string; priority?: number };

export type Context = {
  brief: string;
  linear: Issue[];
  meeting?: { title: string; date: string; summary: string } | null;
};

export type RunEvent =
  | { type: "log"; ts: string; step: string; message: string; speak?: boolean }
  | { type: "plan"; ts: string; plan: Plan }
  | { type: "agent"; ts: string; agent: Agent }
  | { type: "done"; ts: string }
  | { type: "error"; ts: string; message: string };
