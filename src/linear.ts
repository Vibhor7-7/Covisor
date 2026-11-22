// OWNER: context agent (B1). Open Linear issues over the GraphQL API.
// Never throws: every failure comes back as a status with a reason.
import { config } from "./config";
import type { Issue } from "./types";

const LINEAR_URL = "https://api.linear.app/graphql";
export const LINEAR_LIMIT = 10;
const TIMEOUT_MS = 5_000;

// ok: connected (issues may be empty). skipped: no key. error: configured but the call failed.
export type LinearResult =
  | { status: "ok"; issues: Issue[] }
  | { status: "skipped" | "error"; issues: []; reason: string };

// Open = any workflow state whose type is not completed, canceled or duplicate
// (Linear state types: triage, backlog, unstarted, started, completed, canceled, duplicate).
// Query and filter paths checked against Linear's live schema via introspection.
const QUERY = `
  query OpenIssues($first: Int!, $filter: IssueFilter) {
    issues(first: $first, filter: $filter, orderBy: updatedAt) {
      nodes {
        id
        identifier
        title
        priority
        state { name type }
      }
    }
  }
`;

type IssueNode = {
  id: string;
  identifier: string;
  title: string;
  priority: number | null;
  state: { name: string; type: string } | null;
};

type GraphQLResponse = {
  data?: { issues?: { nodes?: IssueNode[] } };
  errors?: Array<{ message?: string }>;
};

// Personal API keys go in the header as is; OAuth tokens need "Bearer".
function authHeader(key: string): string {
  if (/^bearer\s/i.test(key)) return key;
  return key.startsWith("lin_oauth_") ? `Bearer ${key}` : key;
}

// Linear priority: 0 none, 1 urgent, 2 high, 3 medium, 4 low. Urgent first, none last.
function priorityRank(p: number | undefined): number {
  return p === undefined || p === 0 ? 5 : p;
}

function fail(reason: string): LinearResult {
  console.warn(`[context] Linear unavailable: ${reason}`);
  return { status: "error", issues: [], reason };
}

export async function fetchOpenIssues(): Promise<LinearResult> {
  const key = config.linearApiKey.trim();
  if (!key) {
    console.log("[context] Linear skipped: LINEAR_API_KEY is not set");
    return { status: "skipped", issues: [], reason: "LINEAR_API_KEY is not set" };
  }

  const teamKey = config.linearTeamKey.trim().toUpperCase();
  const filter: Record<string, unknown> = {
    state: { type: { nin: ["completed", "canceled", "duplicate"] } },
  };
  if (teamKey) filter.team = { key: { eq: teamKey } };

  let body: GraphQLResponse;
  try {
    const res = await fetch(LINEAR_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: authHeader(key) },
      body: JSON.stringify({ query: QUERY, variables: { first: LINEAR_LIMIT, filter } }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await res.text();
    try {
      body = JSON.parse(text) as GraphQLResponse;
    } catch {
      return fail(`HTTP ${res.status}, non-JSON response`);
    }
    if (body.errors?.length) {
      return fail(`HTTP ${res.status}: ${body.errors.map((e) => e.message ?? "unknown error").join("; ")}`);
    }
    if (!res.ok) return fail(`HTTP ${res.status}`);
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }

  const nodes = body.data?.issues?.nodes;
  if (!Array.isArray(nodes)) return fail("response had no data.issues.nodes");

  const issues: Issue[] = nodes
    .map((n) => {
      const issue: Issue = { id: n.id, key: n.identifier, title: n.title, state: n.state?.name ?? "Unknown" };
      if (typeof n.priority === "number" && n.priority > 0) issue.priority = n.priority;
      return issue;
    })
    // Stable sort: urgent first, then most recently updated (the API order).
    .sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority));

  console.log(`[context] Linear: ${issues.length} open issue(s)${teamKey ? ` for team ${teamKey}` : ""}`);
  return { status: "ok", issues };
}
