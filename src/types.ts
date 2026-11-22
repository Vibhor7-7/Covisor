// Shared contract (PRD Section 4). Do not change without telling the frontend owner.

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

export type ModelChoice = "opus" | "sonnet" | "local";

export type PlanTask = {
  id: string;
  title: string;
  prompt: string;
  acceptance: string[];
  model: ModelChoice;
  reason: string;
  dependsOn: string[];
};

export type Plan = {
  runId: string;
  tasks: PlanTask[];
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

export type Meeting = { title: string; date: string; summary: string };

export type ContextResponse = { brief: string; linear: Issue[]; meeting: Meeting | null };

export type StandupResponse = { summary: string; agents: Agent[] };

export type RunEvent =
  | { type: "log"; ts: string; step: string; message: string; speak?: boolean }
  | { type: "plan"; ts: string; plan: Plan }
  | { type: "agent"; ts: string; agent: Agent }
  | { type: "done"; ts: string }
  | { type: "error"; ts: string; message: string };
