import { useStore } from "./store";
import type { AgentStatus } from "./types";

export type TeamRow = {
  id: string;
  title: string;
  model: string;
  status: AgentStatus;
  detail: string;
  /** Why this model was picked. Empty for agents that are not in the plan. */
  reason: string;
  dependsOn: string[];
  lastActivityAt: string | null;
  /** Everything written about the task, searched for Linear issue keys. */
  text: string;
};

/** Plan tasks joined with their live agents, then any agents from outside the plan. */
export function useTeam(): TeamRow[] {
  const { plan, agents } = useStore().state;
  const live = new Map(agents.map((agent) => [agent.taskId, agent]));
  const planned = (plan?.tasks ?? []).map((task): TeamRow => {
    const agent = live.get(task.id);
    return {
      id: task.id,
      title: task.title,
      model: agent?.model ?? task.model,
      status: agent?.status ?? "queued",
      detail: agent?.detail ?? "",
      reason: task.reason,
      dependsOn: task.dependsOn,
      lastActivityAt: agent?.lastActivityAt ?? null,
      text: [task.title, task.prompt, ...task.acceptance].join(" "),
    };
  });
  const inPlan = new Set(planned.map((row) => row.id));
  const others = agents
    .filter((agent) => !inPlan.has(agent.taskId))
    .map(
      (agent): TeamRow => ({
        id: agent.taskId,
        title: agent.title,
        model: agent.model,
        status: agent.status,
        detail: agent.detail,
        reason: "",
        dependsOn: [],
        lastActivityAt: agent.lastActivityAt,
        text: agent.title,
      }),
    );
  return [...planned, ...others];
}
