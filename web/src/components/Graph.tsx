import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { useCall } from "../call/call";
import { ago, day, modelName, plural, STATUS_LABEL } from "../format";
import { useStore } from "../store";
import { useTeam, type TeamRow } from "../team";
import type { AgentStatus } from "../types";

type Edge = { from: string; to: string; dependency?: boolean };
type Box = { left: number; right: number; y: number };

function IssueState({ state }: { state: string }) {
  const name = state.toLowerCase();
  const kind = /done|complete|merged|closed/.test(name)
    ? "done"
    : /progress|review|started/.test(name)
      ? "started"
      : /backlog|triage/.test(name)
        ? "backlog"
        : "todo";
  return (
    <svg className={`issue-state is-${kind}`} viewBox="0 0 16 16" role="img" aria-label={state}>
      <circle
        cx="8"
        cy="8"
        r="6"
        fill={kind === "done" ? "currentColor" : "none"}
        stroke="currentColor"
        strokeWidth="1.6"
        strokeDasharray={kind === "backlog" ? "2 2.2" : undefined}
      />
      {kind === "started" && <path d="M8 4.2a3.8 3.8 0 0 1 0 7.6z" fill="currentColor" />}
      {kind === "done" && (
        <path d="M5.2 8.2l2 2 3.6-4" fill="none" stroke="var(--bg)" strokeWidth="1.6" />
      )}
    </svg>
  );
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const mentions = (text: string, key: string) => new RegExp(`\\b${escape(key)}\\b`, "i").test(text);
const FROM_MEETING = /\(meeting\)/i;
const STANDUP_ORDER: AgentStatus[] = ["stuck", "needs_review", "working", "done", "queued", "error"];

/** Everything reachable from `start` by following edges one way. */
function reach(start: string, edges: Edge[], forward: boolean): Set<string> {
  const seen = new Set([start]);
  const queue = [start];
  for (let id = queue.pop(); id; id = queue.pop()) {
    for (const edge of edges) {
      const [here, next] = forward ? [edge.from, edge.to] : [edge.to, edge.from];
      if (here === id && !seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return seen;
}

function tally(items: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(item, (counts.get(item) ?? 0) + 1);
  return counts;
}

/** The team in one sentence: how it was staffed, then how it is doing. */
function teamLine(team: TeamRow[], staffing: boolean): string {
  if (staffing) {
    const models = [...tally(team.map((row) => modelName(row.model)))];
    return `Staffed ${plural(team.length, "task")}: ${models.map(([model, n]) => `${n} ${model}`).join(", ")}.`;
  }
  const statuses = tally(team.map((row) => row.status));
  const parts = STANDUP_ORDER.filter((status) => statuses.has(status)).map(
    (status) => `${statuses.get(status)} ${STATUS_LABEL[status].toLowerCase()}`,
  );
  return `${plural(team.length, "agent")}: ${parts.join(", ")}.`;
}

const order = (i: number) => ({ "--i": Math.min(i, 8) }) as CSSProperties;

/**
 * How the work traces back: what Max knew, what was decided, who is building it.
 * Every link is one the data states outright: a Linear key or "(meeting)" named
 * in a decision or task, or a task's `dependsOn`. Nothing is inferred.
 */
export function Graph() {
  const { state } = useStore();
  const call = useCall();
  const { context, spec, backend } = state;
  const team = useTeam();
  const board = useRef<HTMLDivElement>(null);
  const [boxes, setBoxes] = useState<Record<string, Box>>({});
  const [focus, setFocus] = useState<string | null>(null);

  const issues = context?.linear ?? [];
  const meeting = context?.meeting ?? null;
  const items = [...(spec.scopeIn ?? []), ...(spec.decisions ?? [])].map((text) => ({
    id: `item:${text}`,
    text,
  }));

  const links = new Map<string, Edge>();
  const link = (edge: Edge) => links.set(`${edge.from}>${edge.to}`, edge);
  for (const item of items) {
    for (const issue of issues) {
      if (mentions(item.text, issue.key)) link({ from: `issue:${issue.id}`, to: item.id });
    }
    if (meeting && FROM_MEETING.test(item.text)) link({ from: "meeting", to: item.id });
  }
  for (const row of team) {
    for (const issue of issues) {
      if (!mentions(row.text, issue.key)) continue;
      // Route through the decision that names the same issue, when there is one.
      const via = items.filter((item) => mentions(item.text, issue.key));
      if (via.length) via.forEach((item) => link({ from: item.id, to: `agent:${row.id}` }));
      else link({ from: `issue:${issue.id}`, to: `agent:${row.id}` });
    }
    for (const dep of row.dependsOn) {
      link({ from: `agent:${dep}`, to: `agent:${row.id}`, dependency: true });
    }
  }
  const edges = [...links.values()];

  // The edge already shows where an item came from, so its label drops the citation.
  const citation = new RegExp(
    `\\s*\\((?:meeting|${issues.map((issue) => escape(issue.key)).join("|")})\\)\\s*$`,
    "i",
  );

  const ids = [...issues.map((i) => i.id), meeting?.title, ...items.map((i) => i.id), ...team.map((r) => r.id)].join("|");
  useLayoutEffect(() => {
    const el = board.current!;
    // Offsets ignore transforms, so nodes can animate in without bending the edges.
    const measure = () => {
      const next: Record<string, Box> = {};
      el.querySelectorAll<HTMLElement>("[data-node]").forEach((node) => {
        next[node.dataset.node!] = {
          left: node.offsetLeft,
          right: node.offsetLeft + node.offsetWidth,
          y: node.offsetTop + node.offsetHeight / 2,
        };
      });
      setBoxes((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [ids]);

  const lit = focus ? new Set([...reach(focus, edges, true), ...reach(focus, edges, false)]) : null;
  const node = (id: string) => ({
    "data-node": id,
    "data-dim": lit && !lit.has(id) ? "" : undefined,
    onMouseEnter: () => setFocus(id),
    onMouseLeave: () => setFocus(null),
  });

  const slot = new Map(team.map((row, i) => [row.id, i]));
  const working = new Set(team.filter((row) => row.status === "working").map((row) => `agent:${row.id}`));
  const paths = edges.flatMap((edge) => {
    const from = boxes[edge.from];
    const to = boxes[edge.to];
    if (!from || !to) return [];
    let d: string;
    if (edge.dependency) {
      // Dependencies loop down the right edge; longer spans bulge further out.
      const span = Math.abs(slot.get(edge.to.slice(6))! - slot.get(edge.from.slice(6))!);
      const out = (10 + 7 * (span - 1)) / 0.75;
      d = `M${from.right} ${from.y}C${from.right + out} ${from.y} ${to.right + out} ${to.y} ${to.right} ${to.y}`;
    } else {
      const mid = (from.right + to.left) / 2;
      d = `M${from.right} ${from.y}C${mid} ${from.y} ${mid} ${to.y} ${to.left} ${to.y}`;
    }
    const dim = lit && !(lit.has(edge.from) && lit.has(edge.to));
    return [
      <g key={`${edge.from}>${edge.to}`} data-dim={dim ? "" : undefined}>
        <path className="edge" pathLength={1} d={d} />
        <path className="edge-signal" pathLength={1} d={d} />
        {/* Work is flowing into an agent only while that agent is working. */}
        {!edge.dependency && working.has(edge.to) && <path className="edge-flow" pathLength={1} d={d} />}
      </g>,
    ];
  });

  const now = Date.now();
  const detail = (): string => {
    if (!focus) {
      if (team.length === 0) return "Hover anything to trace where it came from.";
      return teamLine(team, Boolean(state.plan) && state.stage === "build");
    }
    const [kind, id] = [focus.slice(0, focus.indexOf(":")), focus.slice(focus.indexOf(":") + 1)];
    if (focus === "meeting" && meeting) return `${meeting.title}, ${day(meeting.date)}. ${meeting.summary}`;
    if (kind === "issue") {
      const issue = issues.find((i) => i.id === id)!;
      return `${issue.key}, ${issue.state}. ${issue.title}`;
    }
    if (kind === "item") return id;
    const row = team.find((r) => r.id === id)!;
    return [
      row.title,
      `${modelName(row.model)}${row.reason ? ` (${row.reason})` : ""}`,
      `${STATUS_LABEL[row.status]}${row.detail ? `: ${row.detail}` : ""}`,
      row.lastActivityAt ? ago(row.lastActivityAt, now) : "",
    ]
      .filter(Boolean)
      .join(" · ");
  };

  const waiting = backend === "down" ? "Waiting for the backend" : "Loading";
  const callingOut = state.stage === "standup" && call.speaking;

  return (
    <>
      <div className="graph-scroll">
        <div className="graph" ref={board}>
          <svg className="graph-edges" aria-hidden="true">
            {paths}
          </svg>

          <section>
            <h2>Context</h2>
            {!context ? (
              <p className="empty">{waiting}</p>
            ) : (
              <>
                {issues.length === 0 && <p className="empty">No Linear issues connected</p>}
                {issues.map((issue, i) => (
                  <div className="node" key={issue.id} style={order(i)} {...node(`issue:${issue.id}`)}>
                    <IssueState state={issue.state} />
                    <span className="node-key">{issue.key}</span>
                    <span className="node-text">{issue.title}</span>
                  </div>
                ))}
                {meeting ? (
                  <div className="node is-stacked" style={order(issues.length)} {...node("meeting")}>
                    <span className="node-text">{meeting.title}</span>
                    <span className="node-key">{day(meeting.date)}</span>
                    <span className="node-sub">{meeting.summary}</span>
                  </div>
                ) : (
                  <p className="empty">No meeting notes connected</p>
                )}
              </>
            )}
          </section>

          <section>
            <h2>Decisions</h2>
            {items.length === 0 && <p className="empty">Decisions land here as you talk.</p>}
            {items.map((item, i) => (
              <div className="node" key={item.id} style={order(i)} {...node(item.id)}>
                <span className="node-text">{item.text.replace(citation, "")}</span>
              </div>
            ))}
          </section>

          <section className="graph-team">
            <h2>Team</h2>
            {team.length === 0 && <p className="empty">Agents appear when Max takes over.</p>}
            {team.map((row, i) => (
              <div
                className={`node is-stacked is-${row.status} ${callingOut && row.status === "stuck" ? "is-called-out" : ""}`}
                key={row.id}
                style={order(i)}
                {...node(`agent:${row.id}`)}
              >
                <span className="dot" />
                <span className="node-text">{row.title}</span>
                <span className="node-sub">
                  {modelName(row.model)} · {row.detail || STATUS_LABEL[row.status]}
                </span>
              </div>
            ))}
          </section>
        </div>
      </div>
      <p className="status-line">{detail()}</p>
    </>
  );
}
